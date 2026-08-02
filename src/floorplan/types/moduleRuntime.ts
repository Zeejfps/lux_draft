import type * as THREE from 'three';
import type { ComponentType, SvelteComponent } from 'svelte';
import type { Readable } from 'svelte/store';
import type { DeepReadonly } from './deepReadonly';
import type { EditorCommand } from './command';
import type { EditorDocument, FloorplanGeometry, SpaceMetadata } from './document';
import type { EntityDescriptor } from './entity';
import type { IInteractionHandler, Interaction } from './interaction';
import type { Selection } from './selection';
import type { DisplayPreferences, ViewMode } from './state';

/**
 * The module **runtime** contract — lazy half (invariant 7).
 *
 * `codec.ts` and `commands.ts` are eager because persistence is synchronous; everything here
 * is rendering and UI and loads behind `ModuleDefinition.loadRuntime()`. Core owns this file
 * and names no module.
 *
 * A module never receives the document or a store (invariant 6). It reads a `ModuleView` typed
 * by its own codec and writes by dispatching a registered command through `ModuleContext`.
 */

export type PanelComponent = ComponentType<SvelteComponent<Record<string, never>>>;

// ============================================
// What a module may read
// ============================================

/**
 * The whole of what a module sees.
 *
 * Two fields go beyond the plan's sketch, both because lighting needs them and neither
 * reachable any other way without handing a module a store:
 *
 * - `displayPreferences` is document data the core owns — unit format and light-radius
 *   visibility drive what a layer draws.
 * - `viewMode` is app presentation state. A layer decides its own visibility from it, which is
 *   what let `EditorRenderer` drop its per-domain `setLightsVisible`/`setVisible` facade.
 */
export interface ModuleView<T> {
  readonly geometry: DeepReadonly<FloorplanGeometry>;
  readonly space: DeepReadonly<SpaceMetadata>;
  readonly displayPreferences: DeepReadonly<DisplayPreferences>;
  readonly data: Readonly<T>;
  readonly selection: Readonly<Selection>;
  readonly viewMode: ViewMode;
}

/** Capabilities, not stores. The only way a write leaves a module. */
export interface ModuleContext<T> {
  dispatch(command: EditorCommand): void;
  select(next: Selection): void;
  setInteraction(next: Interaction): void;
  view(): ModuleView<T>;
}

/** Build a view over a document. The one constructor; used by the activation registry. */
export function moduleViewOf<T>(
  document: EditorDocument,
  data: Readonly<T>,
  selection: Selection,
  displayPreferences: DisplayPreferences,
  viewMode: ViewMode
): ModuleView<T> {
  return {
    geometry: document.geometry,
    space: document.space,
    displayPreferences,
    data,
    selection,
    viewMode,
  };
}

// ============================================
// Contributions
// ============================================

/**
 * One thing drawn into the scene. `EditorRenderer` holds a `SceneLayer[]` and loops; core's
 * own document projections are layers too, so there is one update path rather than a facade
 * method per domain.
 */
export interface SceneLayer {
  readonly id: string;
  update(view: ModuleView<unknown>): void;
  /** Optional selector: skip `update` when this is reference-equal to the last call. */
  inputs?(view: ModuleView<unknown>): unknown;
  setVisible(visible: boolean): void;
  dispose(): void;
}

/**
 * A toolbar tool. Core tools use the same descriptor, so the toolbar is one loop over
 * `coreTools.concat(activeModule.tools)`.
 *
 * `icon` is raw SVG markup rendered inside an `<svg>` element — the toolbar's icons were
 * already inline paths, and inlining them here is what makes a module's tool button work
 * without core knowing it exists.
 */
export interface ToolDescriptor {
  /** `select`, `draw`, … for core; `${moduleId}.${verb}` for a module. */
  readonly id: string;
  readonly label: string;
  readonly title: string;
  /** Title shown when `enabled()` is false. */
  readonly disabledTitle?: string;
  /** A single lower-case key that selects this tool. Not part of the shortcut table. */
  readonly key?: string;
  readonly icon: string;
  /** Re-evaluated whenever the document changes. Reads the owning module's view. */
  enabled?(view: ModuleView<unknown>): boolean;
}

/**
 * A toggle a module contributes to the shell's Overlay section.
 *
 * Without this the shell has to import the module's stores to draw its own buttons — which is
 * legal (`app/**` may import anything) and is exactly what kept the whole of lighting in the
 * eager chunk through phase 4. A toggle arriving through the manifest travels with the lazy
 * runtime instead.
 *
 * `active` is a `Readable`, not `(view) => boolean`: some overlays are document data reachable
 * through the view (rafter visibility) and some are session-local presentation state that is
 * deliberately not in the document (the stats panel, the definition manager). One shape covers
 * both, and a module handing *out* a read-only store is not a module being handed one
 * (invariant 6 is about what a module may read of the session).
 */
export interface OverlayToggle {
  /** `${moduleId}.${verb}`, claimed at validation exactly like a tool id. */
  readonly id: string;
  readonly label: string;
  readonly title: string;
  /** Raw SVG markup, rendered inside the toolbar's `<svg>` — same contract as a tool icon. */
  readonly icon: string;
  readonly active: Readable<boolean>;
  toggle(): void;
}

/** A keyboard binding a module owns for as long as it is active. */
export interface ShortcutDescriptor {
  /** Lower-case key name, e.g. `r`, `escape`, `delete`. */
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  readonly description?: string;
  run(): void;
}

/**
 * Shortcuts the shell owns. **Core wins over modules** — precedence is explicit rather than
 * registration-order, so a module claiming one of these is a registration error rather than a
 * silently shadowed binding (and the module would have been shadowed, since core's
 * `KeyboardShortcutManager` runs first).
 *
 * Tool-selection keys (`v`, `d`, `o`, `l`, …) are deliberately **not** here: they live on
 * `ToolDescriptor.key` and resolve core-first through the tool list, so a module's tool may
 * share a letter with a core tool's without either being a registration failure.
 *
 * `tests/unit/types/moduleRegistry.test.ts` asserts this list against the bindings
 * `createDefaultKeyboardShortcuts` actually produces, so the two cannot drift.
 */
export const CORE_RESERVED_SHORTCUTS: readonly string[] = [
  '1',
  '2',
  '3',
  'u',
  'm',
  'ctrl+z',
  'ctrl+shift+z',
  'ctrl+y',
  'ctrl+a',
  'escape',
  'delete',
  's',
  'p',
];

/** Canonical form used for conflict detection: `ctrl+shift+z`. */
export function shortcutBindingKey(descriptor: {
  key: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}): string {
  const parts: string[] = [];
  if (descriptor.ctrlKey) parts.push('ctrl');
  if (descriptor.shiftKey) parts.push('shift');
  if (descriptor.altKey) parts.push('alt');
  parts.push(descriptor.key.toLowerCase());
  return parts.join('+');
}

// ============================================
// Activation
// ============================================

/**
 * The unit of ownership. Scene layers, input handlers, shortcut bindings, derived
 * subscriptions, projection caches, workers and pending async work all register with it —
 * naming only layers and handlers leaks the rest.
 *
 * The registry owns disposal: a module never disposes its own contributions, and it never
 * holds the scope past `onActivate`.
 */
export interface ActivationScope {
  own(disposer: () => void): void;
  /** Aborted on disposal. Pass to async work, projections and workers. */
  readonly signal: AbortSignal;
}

export interface ModuleRuntime {
  readonly id: string;
  readonly label: string;
  readonly tools?: readonly ToolDescriptor[];
  /** Toolbar toggles, rendered in the shell's Overlay section while this module is active. */
  readonly overlays?: readonly OverlayToggle[];
  /** Point entities this module contributes to core hit-testing, box select and grab mode. */
  readonly entities?: EntityDescriptor<unknown>;
  layers?(scene: THREE.Scene): SceneLayer[];
  handlers?(ctx: ModuleContext<unknown>): IInteractionHandler[];
  /** Keyed by `SelectionKind.panelKey`. */
  readonly panels?: Readonly<Record<string, PanelComponent>>;
  /**
   * Free-standing UI mounted for as long as the module is active — tool panels, stats
   * read-outs, modals. Each takes no props and guards its own visibility, so the shell mounts
   * the list and names none of them. This is what replaced `statsPanel` and the shell's direct
   * imports of `LightToolPanel` / `RafterControls` / `LightDefinitionManager`.
   */
  readonly surfaces?: readonly PanelComponent[];
  readonly shortcuts?: readonly ShortcutDescriptor[];
  onActivate?(ctx: ModuleContext<unknown>, scope: ActivationScope): void;
}

/** Session-scoped runtime status, mirrored into `Diagnostics.runtimeStatus`. */
export type RuntimeState =
  | { status: 'unloaded' }
  | { status: 'loading'; token: number; promise: Promise<void> }
  | { status: 'active'; runtime: ModuleRuntime }
  | { status: 'failed'; error: Error };
