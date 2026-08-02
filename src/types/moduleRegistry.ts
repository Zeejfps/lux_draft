import type { CommandHandler, ModuleCommandEnvelope } from './command';
import type { ModuleCodec, RegisteredCommand } from './module';

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

export function registeredModuleCommands(): readonly RegisteredCommand[] {
  return [...commandsByType.values()];
}

export function moduleCommandHandler(
  type: string
): CommandHandler<ModuleCommandEnvelope> | undefined {
  return commandsByType.get(type)?.handler;
}

/** Test seam. Nothing in `src/` may call this. */
export function clearModuleRegistry(): void {
  definitions.clear();
  commandsByType.clear();
}
