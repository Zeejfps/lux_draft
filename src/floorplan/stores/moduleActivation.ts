import * as THREE from 'three';
import { derived, get, writable, type Readable } from 'svelte/store';
import type { EditorDocument } from '../types/document';
import type { EntityAccess } from '../types/entity';
import type { IInteractionHandler } from '../types/interaction';
import type {
  ActivationScope,
  ModuleContext,
  ModuleRuntime,
  ModuleView,
  PanelComponent,
  RuntimeState,
  SceneLayer,
  ShortcutDescriptor,
  ToolDescriptor,
} from '../types/moduleRuntime';
import { NO_ENTITIES, bindEntities } from '../types/entity';
import { moduleViewOf } from '../types/moduleRuntime';
import { readModule } from '../types/module';
import {
  claimLayerIds,
  codecFor,
  registeredModules,
  validateRuntime,
} from '../types/moduleRegistry';
import { registerPanel, unregisterPanel } from '../ui/panelRegistry';
import { CORE_TOOLBAR_TOOLS } from '../ui/coreTools';
import { roomStore, selection, sessionStore } from './sessionStore';
import { displayPreferences } from './settingsStore';
import { viewMode } from './appStore';

/**
 * Activation is an owned scope.
 *
 * `loadRuntime()` is asynchronous while mode switches, route changes and document opens are
 * not. Five rules make that safe, and all five live here:
 *
 * 1. **The scope is the unit of ownership.** Scene layers, input handlers, shortcut bindings,
 *    panels, derived subscriptions, projection caches, workers and pending async work all
 *    register with it. Naming only layers and handlers leaks the rest.
 * 2. **Dedup.** A second `activate()` for the same id while `loading` returns the in-flight
 *    promise; `import()` is idempotent but the scope construction that follows is not.
 * 3. **Generation token.** Each activation increments a counter; a resolution that arrives
 *    against a stale token constructs and disposes nothing, because it never built anything.
 * 4. **The registry owns disposal.** Modules never dispose their own contributions, and
 *    `sessionStore.open` deactivates first, so no layer sees two unrelated documents.
 * 5. **The record is cached; the scope is not.** The scope binds a `THREE.Scene` and a
 *    `ModuleContext` and is rebuilt per activation — caching it is the straightforward way to
 *    leak a scene.
 */

// ============================================
// The scope
// ============================================

class Scope implements ActivationScope {
  private disposers: (() => void)[] = [];
  private readonly controller = new AbortController();
  private disposed = false;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  own(disposer: () => void): void {
    if (this.disposed) {
      // Ownership after disposal would leak: run it now rather than keep it.
      disposer();
      return;
    }
    this.disposers.push(disposer);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Abort first, so in-flight work owned by the scope stops before its disposers run.
    this.controller.abort();
    for (const disposer of this.disposers.reverse()) {
      try {
        disposer();
      } catch (error) {
        console.error('Module activation disposer threw', error);
      }
    }
    this.disposers = [];
  }
}

// ============================================
// The active record
// ============================================

/** Everything the shell reads off the active module. Rebuilt on every activation. */
export interface ActiveModule {
  readonly id: string;
  readonly label: string;
  readonly runtime: ModuleRuntime;
  readonly layers: readonly SceneLayer[];
  readonly handlers: readonly IInteractionHandler[];
  readonly tools: readonly ToolDescriptor[];
  readonly shortcuts: readonly ShortcutDescriptor[];
  readonly entities: EntityAccess;
  readonly statsPanel: PanelComponent | null;
}

const active = writable<ActiveModule | null>(null);

/** The active module, or null when none is (yet) active. */
export const activeModule: Readable<ActiveModule | null> = { subscribe: active.subscribe };

let scene: THREE.Scene | null = null;
let state: RuntimeState = { status: 'unloaded' };
let activeId: string | null = null;
let scope: Scope | null = null;
let generation = 0;

/** The scene module layers are built into. Set by the canvas before the first activation. */
export function setModuleScene(next: THREE.Scene | null): void {
  scene = next;
}

/** Synchronous read for non-reactive callers (input handlers, the canvas's context builder). */
export function currentActiveModule(): ActiveModule | null {
  return get(active);
}

/** The active module's entities, or the total empty implementation. Never null. */
export function activeEntities(): EntityAccess {
  return currentActiveModule()?.entities ?? NO_ENTITIES;
}

// ============================================
// Context
// ============================================

function buildView(moduleId: string, document: EditorDocument): ModuleView<unknown> {
  const codec = codecFor(moduleId);
  const data = codec ? readModule(document, codec) : {};
  return moduleViewOf(document, data, get(selection), get(displayPreferences), get(viewMode));
}

function buildContext(moduleId: string): ModuleContext<unknown> {
  return {
    dispatch: (command) => sessionStore.dispatch(command),
    select: (next) => sessionStore.select(next),
    setInteraction: (next) => sessionStore.setInteraction(next),
    // The *live* document, so a module's layers preview a drag exactly as core's do.
    view: () => buildView(moduleId, get(roomStore)),
  };
}

// ============================================
// The state machine
// ============================================

/** The scope owns every contribution, so disposing it is the whole of tearing down. */
function teardown(): void {
  scope?.dispose();
  scope = null;
  active.set(null);
}

/**
 * Deactivate whatever is active. Idempotent, synchronous, and the only path that disposes —
 * modules never dispose their own contributions.
 */
export function deactivateModule(): void {
  const previous = activeId;
  generation += 1;
  teardown();
  state = { status: 'unloaded' };
  activeId = null;
  if (previous) sessionStore.setRuntimeStatus(previous, { kind: 'inactive' });
}

function buildActivation(moduleId: string, label: string, runtime: ModuleRuntime): void {
  const owned = new Scope();
  const ctx = buildContext(moduleId);

  const layers = scene && runtime.layers ? runtime.layers(scene) : [];
  claimLayerIds(
    moduleId,
    layers.map((layer) => layer.id)
  );
  for (const layer of layers) owned.own(() => layer.dispose());

  const handlers = runtime.handlers ? runtime.handlers(ctx) : [];

  for (const [key, component] of Object.entries(runtime.panels ?? {})) {
    registerPanel(key, component);
    owned.own(() => unregisterPanel(key));
  }

  const entities = runtime.entities
    ? bindEntities(runtime.entities, () => buildView(moduleId, get(roomStore)))
    : NO_ENTITIES;

  scope = owned;
  activeId = moduleId;
  state = { status: 'active', runtime };
  active.set({
    id: moduleId,
    label,
    runtime,
    layers,
    handlers,
    tools: runtime.tools ?? [],
    shortcuts: runtime.shortcuts ?? [],
    entities,
    statsPanel: runtime.statsPanel ?? null,
  });

  // Last, so a throwing `onActivate` still leaves everything above owned by the scope.
  runtime.onActivate?.(ctx, owned);
  sessionStore.setRuntimeStatus(moduleId, { kind: 'active' });
}

/**
 * Load and activate a module's runtime.
 *
 * Resolves when the mode is settled — active, or failed with the mode disabled. It never
 * rejects: a failed runtime is a session state, not an exception, because the module's data is
 * still live and still saves (invariant 8).
 */
export function activateModule(moduleId: string): Promise<void> {
  const definition = registeredModules().find((d) => d.codec.id === moduleId);
  if (!definition) {
    return Promise.reject(new Error(`No module registered under id "${moduleId}"`));
  }

  if (state.status === 'active' && activeId === moduleId) return Promise.resolve();
  // Dedup: a second activate() for the same id while loading joins the in-flight promise.
  if (state.status === 'loading' && activeId === moduleId) return state.promise;
  if (state.status === 'failed' && activeId === moduleId) return Promise.resolve();

  generation += 1;
  const token = generation;
  teardown();
  activeId = moduleId;

  const load = definition.loadRuntime;
  if (!load) {
    state = { status: 'unloaded' };
    sessionStore.setRuntimeStatus(moduleId, { kind: 'inactive' });
    return Promise.resolve();
  }

  sessionStore.setRuntimeStatus(moduleId, { kind: 'loading' });

  const promise = load()
    .then((runtime) => {
      // A stale resolution builds nothing, so there is nothing to dispose.
      if (token !== generation) return;
      validateRuntime(runtime);
      buildActivation(moduleId, definition.label, runtime);
    })
    .catch((error: unknown) => {
      if (token !== generation) return;
      const failure = error instanceof Error ? error : new Error(String(error));
      state = { status: 'failed', error: failure };
      teardown();
      // Data status is unchanged: the slice is live and saves normally. Only this session's
      // UI for the mode is unavailable.
      sessionStore.setRuntimeStatus(moduleId, { kind: 'failed', message: failure.message });
      console.error(`Module "${moduleId}" runtime failed to load`, failure);
    });

  state = { status: 'loading', token, promise };
  return promise;
}

/**
 * The live view the editor renders: the active module's slice if one is active, otherwise an
 * empty-data view over the same document so core layers still update with no module at all.
 */
export const activeView: Readable<ModuleView<unknown>> = derived(
  [active, roomStore, selection, displayPreferences, viewMode],
  ([$active, $document, $selection, $preferences, $viewMode]) =>
    $active
      ? buildView($active.id, $document)
      : moduleViewOf($document, {}, $selection, $preferences, $viewMode)
);

// ============================================
// The toolbar
// ============================================

export interface ToolbarTool {
  readonly descriptor: ToolDescriptor;
  readonly enabled: boolean;
}

/**
 * Core's tools followed by the active module's, each with its enablement resolved against the
 * live view. `Toolbar.svelte` renders this and nothing else — it names no tool and no module.
 */
export const toolbarTools: Readable<readonly ToolbarTool[]> = derived(
  [active, roomStore, viewMode],
  ([$active, $document]): ToolbarTool[] => {
    const coreView = moduleViewOf(
      $document,
      {},
      get(selection),
      get(displayPreferences),
      get(viewMode)
    );
    const moduleView = $active ? buildView($active.id, $document) : coreView;
    return [
      ...CORE_TOOLBAR_TOOLS.map((descriptor) => ({
        descriptor,
        enabled: descriptor.enabled?.(coreView) ?? true,
      })),
      ...($active?.tools ?? []).map((descriptor) => ({
        descriptor,
        enabled: descriptor.enabled?.(moduleView) ?? true,
      })),
    ];
  }
);

/** The activation state machine, for tests and diagnostics. */
export function runtimeState(): RuntimeState {
  return state;
}

// ============================================
// Document opens deactivate first
// ============================================

sessionStore.beforeOpen(() => {
  const previous = activeId;
  deactivateModule();
  if (previous) void activateModule(previous);
});

/** Test seam: drop every activation without touching the registry. */
export function resetModuleActivation(): void {
  deactivateModule();
  scene = null;
}
