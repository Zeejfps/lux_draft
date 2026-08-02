import type { CommandHandler, ModuleCommandEnvelope } from './command';
import type { ModuleSlices } from './document';
import type { ModuleCodec, RegisteredCommand } from './module';
import type { ModuleRuntime } from './moduleRuntime';
import { buildModuleSlices } from './module';
import { CORE_RESERVED_SHORTCUTS, shortcutBindingKey } from './moduleRuntime';

/**
 * The installed-module table. Core owns it and names no module; `src/modules/codecs.ts` — the
 * eager barrel — is the only thing that fills it, and it does so at import time so
 * `decodeDocument` can stay synchronous (invariant 7).
 *
 * This file lives beside `module.ts` rather than inside `modules/` because
 * `persistence/documentCodec.ts` reads it, and core may not import from `modules/`. The barrel
 * pushes; core pulls.
 *
 * Registration validates and fails fast. A duplicate string shadows silently and surfaces
 * later as the wrong codec decoding a slice or a panel rendering for the wrong selection.
 */

export interface ModuleDefinition<T> {
  readonly codec: ModuleCodec<T>;
  readonly commands: readonly RegisteredCommand[];
  /** Human-readable mode name. Shown by the shell; required so a mode picker has a label. */
  readonly label: string;
  /**
   * The lazy half (invariant 7). Shaped for a dynamic `import()` and implemented as one; phase
   * 5 is what makes the routing lazy and adds the bundle check. Omit for a data-only module.
   */
  loadRuntime?(): Promise<ModuleRuntime>;
}

/** The erased form the table stores. `ModuleCodec<T>` is invariant in `T`. */
type ErasedDefinition = ModuleDefinition<unknown>;

const definitions = new Map<string, ErasedDefinition>();
const commandsByType = new Map<string, RegisteredCommand>();

export function registerModule<T>(definition: ModuleDefinition<T>): void {
  const erased = definition as unknown as ErasedDefinition;
  const { id } = definition.codec;

  const existing = definitions.get(id);
  if (existing) {
    // Re-importing the eager barrel must be a no-op; registering a *different* module under a
    // taken id must not.
    if (existing === erased) return;
    throw new Error(`Duplicate module id "${id}"`);
  }

  if (!id || id.includes('.')) {
    throw new Error(`Invalid module id "${id}": must be non-empty and contain no '.'`);
  }
  if (!definition.label) {
    throw new Error(`Module "${id}" must declare a label`);
  }
  if (definition.codec.schemaVersion < 1) {
    throw new Error(`Module "${id}" must declare schemaVersion >= 1`);
  }

  for (const command of definition.commands) {
    if (command.moduleId !== id) {
      throw new Error(
        `Command "${command.type}" declares moduleId "${command.moduleId}" but is registered ` +
          `by module "${id}"`
      );
    }
    if (!command.type.startsWith(`${id}.`)) {
      throw new Error(`Command "${command.type}" is not namespaced with its module id "${id}"`);
    }
    const clash = commandsByType.get(command.type);
    if (clash) {
      throw new Error(`Duplicate command type "${command.type}" (already registered)`);
    }
    commandsByType.set(command.type, command);
  }

  definitions.set(id, erased);
}

export function registeredModules(): readonly ModuleDefinition<unknown>[] {
  return [...definitions.values()];
}

export function registeredCodecs(): readonly ModuleCodec<unknown>[] {
  return [...definitions.values()].map((d) => d.codec);
}

export function codecFor(moduleId: string): ModuleCodec<unknown> | undefined {
  return definitions.get(moduleId)?.codec;
}

/**
 * A freshly allocated default slice for every installed module — the same normalization
 * `decodeDocument` performs on load, for the documents nothing decoded (a new project, a
 * hand-built test fixture).
 *
 * An absent slice is how a *quarantined* module is represented, so a document that simply has
 * no data yet must still carry a materialized default or its commands would silently no-op.
 */
export function defaultModuleSlices(): ModuleSlices {
  const slices: Record<string, unknown> = {};
  for (const [id, definition] of definitions) {
    slices[id] = definition.codec.defaultData();
  }
  return buildModuleSlices(slices);
}

export function registeredModuleCommands(): readonly RegisteredCommand[] {
  return [...commandsByType.values()];
}

export function moduleCommandHandler(
  type: string
): CommandHandler<ModuleCommandEnvelope> | undefined {
  return commandsByType.get(type)?.handler;
}

// ============================================
// Runtime contributions — validated once, claimed permanently
// ============================================

/**
 * Tool ids, layer ids, panel keys and shortcut bindings live on the **lazy** runtime, so they
 * cannot be checked when the eager barrel registers the module. They are validated the first
 * time a runtime resolves, and the claim is kept **for the rest of the session** rather than
 * released on deactivate.
 *
 * That is what makes a module-vs-module conflict detectable at all: only one module is active
 * at a time, so releasing claims on deactivate would mean two modules could each own `r`
 * forever and the collision would only ever surface as a shortcut doing the wrong thing.
 */
const claimedToolIds = new Map<string, string>();
const claimedLayerIds = new Map<string, string>();
const claimedPanelKeys = new Map<string, string>();
const claimedShortcuts = new Map<string, string>();
const validatedRuntimes = new Set<string>();

function claim(table: Map<string, string>, key: string, moduleId: string, what: string): void {
  const owner = table.get(key);
  if (owner === moduleId) return;
  if (owner !== undefined) {
    throw new Error(`Duplicate ${what} "${key}": claimed by module "${owner}" and "${moduleId}"`);
  }
  table.set(key, moduleId);
}

/**
 * Validate a resolved runtime against the registry and claim its contributions. Throws — a
 * duplicate string shadows silently and surfaces later as a panel rendering for the wrong
 * selection or a shortcut firing the wrong action.
 *
 * Idempotent: re-activating a module re-validates the same runtime object and re-claims the
 * same strings, which is a no-op.
 */
export function validateRuntime(runtime: ModuleRuntime): void {
  const definition = definitions.get(runtime.id);
  if (!definition) {
    throw new Error(`Runtime "${runtime.id}" has no registered module definition`);
  }
  if (runtime.id !== definition.codec.id) {
    throw new Error(`Runtime id "${runtime.id}" does not match codec id "${definition.codec.id}"`);
  }
  if (validatedRuntimes.has(runtime.id)) return;

  const id = runtime.id;
  const seenTools = new Set<string>();
  for (const tool of runtime.tools ?? []) {
    if (!tool.id.startsWith(`${id}.`)) {
      throw new Error(`Tool "${tool.id}" is not namespaced with its module id "${id}"`);
    }
    if (seenTools.has(tool.id)) {
      throw new Error(`Duplicate tool id "${tool.id}" within module "${id}"`);
    }
    seenTools.add(tool.id);
    claim(claimedToolIds, tool.id, id, 'tool id');
  }

  for (const key of Object.keys(runtime.panels ?? {})) {
    claim(claimedPanelKeys, key, id, 'panel key');
  }

  for (const shortcut of runtime.shortcuts ?? []) {
    const binding = shortcutBindingKey(shortcut);
    if (CORE_RESERVED_SHORTCUTS.includes(binding)) {
      throw new Error(
        `Shortcut "${binding}" is bound by the core shell; core wins over modules ` +
          `(module "${id}")`
      );
    }
    claim(claimedShortcuts, binding, id, 'shortcut binding');
  }

  if (runtime.entities && runtime.entities.selection.moduleId !== id) {
    throw new Error(
      `Module "${id}" contributes entities selected as ` +
        `"${runtime.entities.selection.panelKey}", which belongs to another module`
    );
  }

  // Layer ids are only knowable by building them, which needs a scene, so `claimLayerIds`
  // claims those separately at activation.
  validatedRuntimes.add(id);
}

/** Claim the ids of the layers a runtime just built. Separate because building needs a scene. */
export function claimLayerIds(moduleId: string, layerIds: readonly string[]): void {
  const seen = new Set<string>();
  for (const layerId of layerIds) {
    if (seen.has(layerId)) {
      throw new Error(`Duplicate layer id "${layerId}" within module "${moduleId}"`);
    }
    seen.add(layerId);
    claim(claimedLayerIds, layerId, moduleId, 'layer id');
  }
}

/** Core's own scene layers claim their ids too, so a module cannot shadow one. */
export function claimCoreLayerIds(layerIds: readonly string[]): void {
  claimLayerIds('core', layerIds);
}

/** Core panel keys claim theirs for the same reason. */
export function claimCorePanelKeys(panelKeys: readonly string[]): void {
  for (const key of panelKeys) claim(claimedPanelKeys, key, 'core', 'panel key');
}

/** Test seam. Nothing in `src/` may call this. */
export function clearModuleRegistry(): void {
  definitions.clear();
  commandsByType.clear();
  claimedToolIds.clear();
  claimedLayerIds.clear();
  claimedPanelKeys.clear();
  claimedShortcuts.clear();
  validatedRuntimes.clear();
}
