# Studio Modularization Plan

**Goal:** extract a domain-agnostic floorplan editor from the lighting-specific code, so a second
domain (LVP flooring layout) can be built on top of it without forking or duplicating.

**Status:** proposed, not started.
**Created:** 2026-08-02

---

## 1. Decision summary

Three options were considered:

| Option                                           | Verdict                                                                                                                                                                                                                 |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Separate repo / fork the app                     | No — duplicates 11k LOC of editor code that will diverge immediately.                                                                                                                                                   |
| Monorepo with shared packages now                | No — premature at 19k LOC with one shipping app. Costs workspace tooling, build ordering, cross-package HMR friction, and version churn; buys nothing until there is a second consumer with a separate release cadence. |
| **Single repo, module registry, "Studio" shell** | **Yes.**                                                                                                                                                                                                                |

The decisive argument: the module-registry approach does not foreclose the monorepo. If flooring
later needs its own branding, deploy, or release cadence, it becomes a second Vite entry point from
the same source tree, and only then a package split. Going monorepo now is the only option that is
expensive to undo.

**Product shape:** one Studio, one document, switchable modes. The room polygon is drawn once and
both the lighting plan and the flooring plan live on it (kitchen remodel: same room, plan the cans
and plan the LVP). That is a real feature that two separate apps cannot offer, and it falls out for
free once the document is `geometry + modules`.

**Split the monorepo when** one of these is true, not before:

- A second consumer needs a different release cadence.
- The core is worth publishing independently.
- Build times become painful.

---

## 2. What is shared vs. domain-specific

Measured against the current tree (~19k LOC).

### Shared floorplan core (~11k LOC, reusable as-is)

| Area                  | Files                                                                                               | LOC   |
| --------------------- | --------------------------------------------------------------------------------------------------- | ----- |
| Scene, input          | `core/Scene.ts`, `core/InputManager.ts`                                                             | 372   |
| Geometry              | `geometry/` — SnapEngine, PolygonValidator, WallBuilder, DimensionLabel                             | 377   |
| Interactions          | `interactions/` — DragManager, InteractionManager, drag ops, drawing/selection/measurement handlers | 4234  |
| Rendering             | Wall, Door, Obstacle, DrawingPreview, Overlay, Measurement renderers                                | ~1400 |
| Persistence           | localStorage, jsonExport/Import, shareUrl                                                           | 584   |
| Controllers, services | SnapController, MeasurementController, GeometryService, SelectionService                            | 860   |
| UI shell              | FloatingPanel, Toolbar chrome, StatusBar, LengthInput, PropertyPanel, theming                       | ~1500 |

### Lighting-specific (stays, moves under `modules/lighting/`)

`lighting/` (IESParser, LightCalculator, LightManager, LightingStatsCalculator, SpacingAnalyzer,
LightIcon — 1119 LOC), `HeatmapRenderer`, `ShadowRenderer`, `BaseLightingRenderer`,
`LightRenderer`, `DeadZoneRenderer`, `SpacingWarningRenderer`, `RafterOverlay`,
`LightPlacementHandler`, all `Light*` / `Rafter*` / `*Stats*` Svelte components, and the
`deadZone` / `spacing` / `lightDefinitions` / `lightingStats` stores.

### Flooring-specific (new)

Plank layout engine (run direction, plank dimensions, stagger/offset rule, start course, expansion
gap), cut list + waste calculation, transitions/thresholds, underlayment notes, instanced plank
renderer, plank/course property panels.

### Domain luck worth calling out

- **Obstacles are already floor cutouts.** Islands, cabinets, hearths — the `Obstacle` polygon type
  and its drawing/drag/vertex-edit machinery transfer with zero changes.
- **Doors are already transition/threshold locations.** `Door` carries wall id + offset + width,
  which is exactly what a threshold needs.
- SnapEngine, PolygonValidator, DimensionLabel, and the measurement tool transfer unchanged.

---

## 3. Architectural spine

Successive design passes over this plan produced a growing list of rules that implementers must
remember:

- quarantined blobs must not live on `RoomState`, or history clones them 50 times;
- derived layout output must not live on `RoomState`, for the same reason;
- an absent module slice must resolve at read time and must not write, or visiting a mode dirties
  the document;
- a module edit must commit exactly once, or one user action becomes two undo entries;
- a load must `pauseRecording()` then `clear()` and specifically must **not** call
  `resumeRecording()`, or the first Ctrl-Z resurrects the previous document;
- a load must reset five stores together, or the previous document's quarantine attaches to the next
  save;
- selection must be cleared on document swap, or stale ids survive it.

Every one of those has the same root cause. The document is an **ambient mutable store**, and
`historyStore` **infers** that an edit happened by subscribing to it and `JSON.stringify`-diffing
(`historyStore.ts:15-18,49-62`). Because intent is inferred rather than declared, every write path
has to be careful about how many times it emits, what is inside the observed object, and in what
order it touches sibling stores.

The fix is to remove the inference. Four structural moves, each of which deletes a rule from that
list rather than documenting it.

### 3.1 A session is one value, not five stores

```ts
// src/floorplan/types/session.ts

/** Editable, undoable, persisted. Nothing else belongs in here. */
export interface RoomState {
  ceilingHeight: number;
  walls: WallSegment[];
  doors: Door[];
  obstacles: Obstacle[];
  isClosed: boolean;
  displayPreferences?: DisplayPreferences;
  /** Opaque; reachable only via readModule / commitModule (§3.4). */
  modules: ModuleSlices;
}

/** Persisted, never edited, never rendered. Carried from load to save. */
export interface CarriedState {
  quarantined: Readonly<Record<string, ModuleBlob>>;
}

/** Session-scoped. Not persisted, not undoable. */
export interface Diagnostics {
  warnings: DocumentWarning[];
  disabledModules: string[];
}

export interface History {
  past: RoomState[];
  future: RoomState[];
  /** Label of the commit that would be undone next; drives the UI. */
  undoLabel: string | null;
  redoLabel: string | null;
}

export interface Session {
  readonly document: RoomState;
  readonly carried: CarriedState;
  readonly diagnostics: Diagnostics;
  readonly selection: Selection;
  readonly history: History;
}
```

The three data lifetimes — _editable_, _carried_, _derived_ — become three positions in a type
instead of three conventions. Derived data gets no field at all: it lives in memoized derived stores
computed from `session.document` and has nowhere to be written to.

`history` snapshots `RoomState` only. Quarantine, diagnostics, and selection are siblings of the
document, so their exclusion from undo is structural — not a `readonly` marker that TypeScript
erases at compile time while `structuredClone` copies the field anyway.

### 3.2 Writes are commits, not sets

One store, and it does not expose `set` or `update`:

```ts
// src/floorplan/stores/sessionStore.ts
export const sessionStore = {
  subscribe,

  /** The only way a document enters the app. */
  open(loaded: LoadedDocument): void,

  /** One user action → one snapshot → one history entry. */
  commit(label: string, fn: (doc: Readonly<RoomState>) => RoomState): void,

  /** Selection is not undoable; changing it records no history. */
  select(next: Selection): void,

  /**
   * Multi-step interactions (wall drag, vertex drag). Spans pointer events;
   * intermediate documents apply live, the whole gesture lands as one entry. §3.2.1.
   */
  begin(label: string): Gesture,

  /** Sugar over `begin` for the synchronous case. §3.2.1. */
  transact<T>(label: string, fn: (g: Gesture) => T): T,

  undo(): boolean,
  redo(): boolean,
};

/** Read-only view. Every existing `$roomStore` read site keeps working unchanged. */
export const roomStore = derived(sessionStore, (s) => s.document);
```

`open` constructs a whole new `Session` whose `history` is `{ past: [], future: [] }`. There is no
code path by which opening a document could push an undo entry, because opening is not a commit.
`carried` is replaced along with the document, so a previous document's quarantine cannot outlive it.
`selection` is reset in the same value, so stale ids cannot survive a swap.

`begin`/`commit`/`cancel` replaces the `pauseRecording()`/`resumeRecording()` pair with a handle whose
lifetime is the gesture's, so there is no global pause flag to leak and no comparison against a stale
`stateBeforePause`. §3.2.1 pins down its semantics — it is the one piece of this design with real
edge cases.

`statesAreEqual` and its `JSON.stringify` of the entire document on every emission are deleted, not
optimized — history is now told what happened. (This resolves what earlier drafts filed as a
follow-up performance item; it comes free.)

**Every writer converts in one phase.** Making `roomStore` derived is not a gradual change: the
moment it loses `set`/`update`, every existing writer stops compiling. That is the desired property —
the compiler produces the migration checklist — but it means phase 1 must convert all 29 sites (14 in
`roomStore.ts`, 15 outside it), not just the ones outside `roomStore.ts`. Full inventory:

| Where                                                                                                                                                                                                                                                                    | Count | Becomes                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | -------------------------------------------------------------------------------------------------- |
| `roomStore.ts` helper internals — `updateWallLength`, `updateVertexPosition`, `insertVertexOnWall`, `moveWall`, `deleteVertex`, `addDoor`, `updateDoor`, `removeDoor`, `addObstacle`, `updateObstacle`, `removeObstacle`, `updateObstacleVertexPosition`, `moveObstacle` | 13    | `commit(label, fn)` — bodies are already `(state) => newState`, so the lambda moves over unchanged |
| `roomStore.resetRoom`                                                                                                                                                                                                                                                    | 1     | `open(emptyDocument())`                                                                            |
| `historyStore.undo` / `.redo`                                                                                                                                                                                                                                            | 2     | deleted with `historyStore`                                                                        |
| Load paths — `App.svelte:124`, `ViewerPage.svelte:27,55`, `Toolbar.svelte:158`                                                                                                                                                                                           | 4     | `open(loaded)`                                                                                     |
| Genuine edits — `settingsStore:22,28`, `PropertyPanel:32`, `LightPropertiesPanel:32,54`, `Canvas.svelte:574,616,667,709`                                                                                                                                                 | 9     | `commit(label, fn)`                                                                                |

The helper conversions are the cheap ones — those functions already take the shape `commit` wants
and merely need a label. The four `roomStore.set` load paths are the ones that change semantics, and
that is the point: they are exactly the sites that push a spurious undo entry today.

Read sites — the large majority, including every Svelte template and every
`get(roomStore)` — are untouched, because `roomStore` survives as a derived view.

### 3.2.1 Gestures — the replacement for pause/resume

A drag is not a synchronous scope. `DragManager.startDrag()` pauses history (`DragManager.ts:66`),
`updateDrag()` is called from later pointer events, and `cleanup()` resumes (`DragManager.ts:166`)
from either `commitDrag()` or `cancelDrag()`. The gesture spans an unbounded number of event-loop
turns, so no callback-scoped API can hold it open: wrapping `startDrag` alone closes before the first
update, and wrapping each update produces one history entry per pointer move.

The primitive is therefore an explicit long-lived handle, not a callback:

```ts
export interface Gesture {
  /** Applies and emits immediately, so the canvas updates live. Records no history. */
  apply(fn: (doc: Readonly<RoomState>) => RoomState): void;
  /** Close: push one entry if the document changed in value. Returns whether it did. */
  commit(): boolean;
  /** Close: restore the entry snapshot, push nothing. Idempotent. */
  cancel(): void;
  readonly isOpen: boolean;
}

/** Opens a gesture. At most one may be open at a time. */
begin(label: string): Gesture;

/** Sugar for the synchronous case: begin, run, commit — with cancel on throw. */
transact<T>(label: string, fn: (g: Gesture) => T): T;
```

`begin`/`commit`/`cancel` map one-to-one onto `startDrag`/`commitDrag`/`cancelDrag`, so the
`onPauseHistory` / `onResumeHistory` callbacks in `DragManagerCallbacks` are replaced by the manager
holding a `Gesture | null` — which it already does for `currentOperation`.

`cancel()` restoring the entry snapshot directly is also stronger than what exists today, where
`cancelDrag()` depends on each `IDragOperation.cancel()` correctly undoing its own writes and then
relies on resume finding no net change. The snapshot is the source of truth; per-operation cancel
correctness stops being load-bearing.

Rules while a gesture is open:

| Call                    | Behavior                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `begin(...)`            | **Throws.** A second gesture means a leaked one — the loud failure is the leak detector.                                                          |
| `commit(label, fn)`     | **Throws.** It would either be absorbed into the gesture under the wrong label or split the gesture into two entries.                             |
| `undo()` / `redo()`     | No-op, returns `false`. The gesture resolves first; a mid-drag Ctrl-Z is not a meaningful request.                                                |
| `open(loaded)`          | **Cancels the gesture, then opens.** Refusing a document load strands the app in a worse state than dropping an in-flight drag. Dev-mode warning. |
| `select(...)`           | Allowed. Selection is not undoable, and drag operations legitimately adjust it.                                                                   |
| `apply` on a closed one | **Throws.** Catches a handler that kept a stale handle past `commit`/`cancel`.                                                                    |

And for `transact`, which is only sugar over the primitive:

- **Synchronous only** — throws if `fn` returns a thenable. An `async` callback would return before
  its own `apply` calls ran, committing an empty gesture and leaving the rest to leak out as
  individual entries. Use `begin` for anything genuinely asynchronous.
- **`try` / `catch` / `finally`** — on throw the gesture is cancelled (entry snapshot restored) and
  the error propagates. On normal return it commits.
- **Nesting throws**, via the `begin` rule above. Escalate to depth-counted outermost-snapshot
  semantics only if a real interaction needs composition.

**Leak containment.** A gesture left open suppresses history indefinitely, so the exits must be
exhaustive: `pointerup`, `pointercancel`, and window `blur` all route to `commitDrag`/`cancelDrag`.
`pointercancel` and `blur` are not wired today — worth fixing while the drag paths are already open in
phase 1.

#### No-op detection is a value comparison at close, not reference equality

The drag helpers rebuild `RoomState`, the walls array, and the touched wall on every update, so a
pointer that wanders away and returns to its origin produces a document that is value-equal but never
reference-equal to the entry snapshot. Reference equality would let that consume an undo step.

`commit()` therefore resolves in this order:

1. No `apply` was ever called → push nothing. (Covers the common case — a click that registers as a
   zero-distance drag — without any comparison at all.)
2. Exit document is reference-equal to the entry snapshot → push nothing.
3. Otherwise **one structural deep comparison** against the entry snapshot; push only if it differs.

This does not reintroduce the problem §3.2 deletes. The old `statesAreEqual` ran a full
`JSON.stringify` of the document on _every_ `roomStore` emission, including every frame of every
drag. This runs at most one comparison per completed gesture — roughly once per pointer-up — against
a document that excludes derived data by construction (§7.4a).

The alternative, having each `IDragOperation` report whether it changed anything, was rejected: it is
per-operation discipline that every new drag op must remember to get right, which is the category of
rule this architecture exists to eliminate.

Tests, non-optional and cheap: gesture with no `apply`; gesture that returns to its origin (the
value-equality case); throwing `transact` callback; `async` callback rejected; nested `begin`
rejected; `commit` during a gesture rejected; `open` during a gesture cancelling it; N `apply` calls
→ exactly one history entry; and a per-drag-op test that intermediate frames still reach the
renderer.

### 3.3 Normalize on load, prune on save

An absent module slice creates three states where two suffice: absent, default-but-unwritten, and
materialized. That trichotomy is what forces read-time defaults, the "activation must never write"
rule, and a special `updateModuleData` helper that must materialize and edit in a single emission.

Collapse it:

- **On load**, `decodeDocument` materializes `codec.defaultData()` for every registered, enabled
  module. After decode, `document.modules[id]` is always present for every live module.
- **On save**, `encodeDocument` omits any slice that deep-equals its codec's default.

Now reads are ordinary field reads, writes are ordinary commits, and visiting a mode for the first
time produces a document that serializes identically to the one that was loaded. Autosave dirty
checks compare normalized documents to normalized documents, so an empty mode visit is not an edit.
`§7.2`'s absent-slice row and the whole read-time-default mechanism disappear.

### 3.4 Module identity is a token, not a string

`Record<string, unknown>` indexed by a string literal is the plan's remaining source of
representable-invalid state: a typo or a rename produces `undefined` at runtime, far from the
mistake. Carry identity in a value instead.

**Slices** — the codec is generic, and it is the key:

```ts
export interface ModuleCodec<T> {
  readonly id: string;
  readonly schemaVersion: number;
  /** MUST return a freshly-allocated value on every call. See §3.4.1. */
  defaultData(): T;
  decode(blob: ModuleBlob): DecodeResult<T>;
  compactForShare?(data: Readonly<T>): unknown;
}

/** `ModuleSlices` is opaque — no index signature is exported, so these are the only doors. */
export function readModule<T>(doc: Readonly<RoomState>, codec: ModuleCodec<T>): Readonly<T>;
export function commitModule<T>(
  codec: ModuleCodec<T>,
  label: string,
  fn: (prev: Readonly<T>) => T
): void;
```

Call sites read `readModule(doc, lightingCodec)` and get `LightingData`, not `unknown`. The id string
is written once, in the codec.

This also makes "`modules[id]` holds input, never output" a fact rather than a rule. `T` is named by
`codec.ts`, and the boundary lint rule (§4) forbids `codec.ts` from importing `runtime.ts` — so the
plank-layout _output_ type is not nameable from anywhere that can write a slice.

### 3.4.1 Documents and defaults are immutable

The commit model assumes callers do not mutate what they are handed. Left implicit, it breaks in two
ways, and the second is nasty:

1. A caller mutates the value from `readModule` (or a `commit` callback's `doc`) in place. The
   document changes with no snapshot and no history entry, and undo silently skips the edit.
2. `defaultData()` returns a shared object — a module-level `const`, or an object literal captured
   by a closure. Normalization (§3.3) stores that same reference into the document, a caller mutates
   it, and now the baseline that prune-on-save deep-compares against has drifted to match the
   document. The slice is pruned on save and the user's data is silently dropped. This one survives
   review easily and shows up as data loss much later.

Three defenses, none expensive:

- **`Readonly<T>` at every boundary.** `readModule` returns `Readonly<T>`; `commit` and
  `commitModule` hand their callbacks readonly input and require a new value back. This catches
  top-level field assignment at compile time. It is shallow — `doc.walls.push(w)` still type-checks
  — so it is a first line, not the guarantee.
- **Deep-freeze in development.** `open`, every `commit`, and every `defaultData()` result pass
  through a recursive `Object.freeze` under `import.meta.env.DEV`, stripped in production builds.
  This is what actually catches the nested mutations `Readonly<T>` misses, and it converts silent
  drift into a `TypeError` at the mutation site rather than a wrong result three operations later.
  Existing helper bodies already build new objects (`{ ...state, walls: [...] }`), so the expected
  number of violations to fix is small.
- **Fresh-default test, applied to every codec.** A shared contract test — run against each
  registered codec, not written per module — asserting `defaultData() !== defaultData()` and that
  mutating one result leaves a second call unaffected. This is the test that closes failure (2), and
  it must be part of the codec registration suite so a new module gets it for free.

**Selections** — same trick, and it retires the hand-written validating guard:

```ts
export interface SelectionKind<T> {
  readonly panelKey: string; // `${moduleId}.${type}`
  make(payload: T): Selection;
  match(s: Selection): T | null;
}

export function defineSelection<T>(
  moduleId: string,
  type: string,
  parse: (u: unknown) => T | null
): SelectionKind<T>;

// modules/lighting/selection.ts
export const fixtureSelection = defineSelection<{ ids: string[] }>('lighting', 'fixture', (u) => {
  const ids = (u as { ids?: unknown } | null)?.ids;
  return Array.isArray(ids) && ids.every((i) => typeof i === 'string') ? { ids } : null;
});
```

`'lighting'` and `'fixture'` appear exactly once each. `make` and `match` are generated from the same
pair, so producer and consumer cannot drift apart during a refactor — which was the actual failure
mode the guard existed to catch. (Selection is transient in-memory state, never persisted and never
parsed from untrusted input, so the `parse` step is a refactor safety net, not a security boundary.)

### 3.5 What this buys, itemized

| Rule that had to be remembered                     | Now                                                                    |
| -------------------------------------------------- | ---------------------------------------------------------------------- |
| Quarantine must not be inside `RoomState`          | It is a sibling field of `Session`; history snapshots `RoomState` only |
| Derived output must not be stored                  | Derived data has no field, and its type is unnameable from `codec.ts`  |
| Absent slices resolve at read time, never write    | Slices are normalized on load, pruned on save                          |
| Module edits must emit exactly once                | `commitModule` is one call, one snapshot                               |
| Loads must pause, then `clear()`, never `resume()` | `open()` builds a fresh `Session`; opening is not a commit             |
| Loads must reset five stores together              | One value, set once                                                    |
| Selection must be cleared on document swap         | It is part of the value being replaced                                 |
| `resetRoom()` must be folded into the load path    | `resetRoom` becomes `open(emptyDocument())`                            |
| Multi-step drags must pause/resume history         | `begin(label)` returns a handle scoped to the gesture (§3.2.1)         |

Costs, stated honestly:

- One large mechanical pass over **all 29 write sites** (§3.2), which cannot be split across phases —
  the moment `roomStore` becomes derived, every writer breaks at once.
- The gesture API is the one genuinely subtle piece, and it is subtle because drags are: it needs the
  explicit open/close semantics, exit-path coverage, and end-of-gesture value comparison spelled out
  in §3.2.1. This is less machinery than pause/resume plus per-emission diffing, but it is not free.
- One deep-equal comparison per gesture close, and one per module slice on save (cheap — slices are
  small by construction, since output is never stored).
- `Session` is a wide object that every write reconstructs; structural sharing makes this a handful
  of allocations per commit.

---

## 4. Target structure

```
src/
  floorplan/          # domain-agnostic editor core
    core/             # Scene, InputManager
    geometry/         # SnapEngine, PolygonValidator, WallBuilder, DimensionLabel
    interactions/     # DragManager, InteractionManager, generic handlers + drag ops
    rendering/        # Wall, Door, Obstacle, DrawingPreview, Overlay, Measurement
    stores/           # sessionStore (+ roomStore/selection/history derived views),
                      #   settingsStore, themeStore
    persistence/      # documentCodec, localStorage, json, shareUrl (module-agnostic)
    types/            # geometry, session, module, interaction, selection
    ui/               # FloatingPanel, LengthInput, StatusBar, PropertyPanel primitives
  modules/
    codecs.ts         # eager barrel: every module's codec, statically imported
    lighting/
      codec.ts        # EAGER — schema, defaults, decode, compactForShare. No THREE, no Svelte.
      runtime.ts      # LAZY  — tools, layers, handlers, panels, stats
      ...             # types, stores, renderers, components
    flooring/         # (new) same shape
  app/                # Studio shell: mode picker, routing, toolbar composition, module registry
  main.ts
```

Boundaries are **directories plus lint rules**, not packages. Enforced via
`eslint-plugin-import` (or `eslint-plugin-boundaries`) in `eslint.config.js`:

- `src/floorplan/**` may not import from `src/modules/**` or `src/app/**`.
- `src/modules/a/**` may not import from `src/modules/b/**`.
- `src/modules/*/codec.ts` may not import from its own `runtime.ts`, from `three`, or from
  `*.svelte`.
- `src/app/**` may import from anywhere.

Worth adding on day one — the repo already runs `knip` and `jscpd`, so there is an existing appetite
for mechanical enforcement, and a lint rule is what actually keeps the seam from rotting. The
codec/runtime rule is doubly load-bearing: it keeps the eager codec bundle small (without it, one
stray import silently pulls the IES parser into every bundle), and per §3.4 it is what makes
"derived output can never be stored" a type-level fact.

---

## 5. The module contract

Split in two. **This split is the resolution to the lazy-loading/synchronous-persistence conflict:**
data handling is eager and synchronous, UI and rendering are lazy.

### 5.1 Codec — eager, synchronous, dependency-light

Every module's codec is statically imported by `modules/codecs.ts`. Codecs are pure data functions
with no `three` and no Svelte imports, so the eager cost is a few KB per module regardless of how
heavy the module's runtime is.

```ts
// src/floorplan/types/module.ts — core owns this type; it names no module
export interface ModuleCodec<T> {
  readonly id: string;
  /** Current schema version this build writes. */
  readonly schemaVersion: number;

  /** Fresh slice for a document that has none. Must be cheap and pure. */
  defaultData(): T;

  /** Decode a stored blob. Never throws — returns a status. */
  decode(blob: ModuleBlob): DecodeResult<T>;

  /** Strip derived/non-essential fields for share URLs. Defaults to identity. */
  compactForShare?(data: T): unknown;
}

/** On-disk envelope for one module's slice. */
export interface ModuleBlob {
  v: number;
  data: unknown;
}

export type DecodeResult<T> =
  /** Understood and migrated to the current schema. */
  | { status: 'ok'; data: T }
  /** Written by a newer build. Blob is preserved verbatim; module is disabled this session. */
  | { status: 'unsupported'; writtenVersion: number; message: string }
  /** Corrupt or fails validation. Blob is preserved verbatim; module is disabled this session. */
  | { status: 'invalid'; message: string };
```

`decode` returning a status rather than throwing is what makes "preserve unknown blobs verbatim"
implementable: the pipeline can distinguish _known-and-valid_, _known-but-future_,
_known-but-corrupt_, and _unknown module id_ (no codec registered at all), and handle each
differently. See §7.2 for the policy table. (There is no _absent_ case at the pipeline level — §3.3
normalizes absent slices to defaults during decode.)

### 5.2 Runtime — lazy, loaded when a module is activated

```ts
export interface ModuleRuntime {
  readonly id: string;
  readonly label: string;

  tools: ToolDescriptor[];
  layers(scene: THREE.Scene): SceneLayer[];
  handlers(ctx: ModuleContext): IInteractionHandler[];
  /** Property panel per selection kind this module owns, keyed by `SelectionKind.panelKey`. */
  panels: Record<string, ComponentType>;
  statsPanel?: ComponentType;
  shortcuts?: ShortcutDescriptor[];
}

export interface ToolDescriptor {
  id: string; // namespaced: 'lighting.place', 'flooring.origin'
  label: string;
  icon: string;
  shortcut?: string;
  /** Gate on document state, e.g. requires a closed polygon. */
  enabled?: (doc: RoomState) => boolean;
}

export interface SceneLayer {
  id: string;
  update(doc: RoomState, selection: Selection): void;
  setVisible(v: boolean): void;
  dispose(): void;
}
```

Registration pairs the two halves:

```ts
// src/app/moduleRegistry.ts
registry.register({
  codec: lightingCodec, // eager, already imported
  loadRuntime: () => import('../modules/lighting/runtime'), // lazy
});
```

`SceneLayer` is deliberately the shape the existing renderers almost have already — they all expose
`update(...)`, `setVisible(...)`, `dispose()`. The change is narrowing `update` to
`(doc, selection)` so `EditorRenderer` can hold a `SceneLayer[]` and loop, instead of naming each
renderer as a field with a bespoke method (`updateLights`, `updateDoors`, `updateObstacles`).

---

## 6. The three blockers in the core

These are the concrete things that make the core lighting-aware today. Everything else is a file
move.

### Blocker A — `RoomState.lights` is a hardcoded field

`src/types/state.ts:4-13` puts `lights: LightFixture[]` on the shared document, and
`src/types/index.ts` re-exports `./lighting` from the shared type barrel. `jsonImport.ts`
hard-requires `obj.lights` to be an array (`validateRoomState`), `jsonExport.ts` and `shareUrl.ts`
both read `state.lights` directly to find used light definitions, and `DEFAULT_ROOM_STATE` seeds
`lights: []`.

Target: the `RoomState` / `Session` shape in §3.1. `lights` moves into `modules.lighting`, reachable
only through `readModule(doc, lightingCodec)`.

`rafterConfig` moves into the lighting slice too — a ceiling-joist concept with no meaning for
flooring. `ceilingHeight` stays on the core document (it is a room property), but note it is only
_consumed_ by lighting today.

### Blocker B — the selection model is six parallel stores

`src/stores/appStore.ts` holds `selectedLightIds`, `selectedWallId`, `selectedVertexIndices`,
`selectedDoorId`, `selectedObstacleId`, `selectedObstacleVertexIndices`. Every `select*` function
manually clears the other five, and `clearSelection` / `setActiveTool` each clear all six. Adding
plank / course / transition selections would make that eleven mutually-clearing stores — the bug
surface grows quadratically.

Target: one discriminated union, held in `Session` (§3.1). Cardinality is expressed structurally —
`id: string` for single-select kinds, `indices` / `ids` arrays for multi-select kinds — so "does this
kind support multi-select" is answered by the type rather than by convention.

```ts
// src/floorplan/types/selection.ts
export type Selection =
  | { kind: 'none' }
  | { kind: 'wall'; id: string }
  | { kind: 'vertex'; indices: number[] }
  | { kind: 'obstacle'; id: string }
  | { kind: 'obstacleVertex'; obstacleId: string; indices: number[] }
  | { kind: 'door'; id: string }
  /** Extension point: core stays module-agnostic. Constructed only via SelectionKind (§3.4). */
  | { kind: 'module'; moduleId: string; type: string; payload: unknown };
```

Core variants keep their natural types — `vertex` carries real `number[]`, never stringified indices.
Modules never construct the `module` variant by hand; they go through `defineSelection` (§3.4), which
owns the id/type strings and the payload parse.

Panel dispatch key: `s.kind === 'module' ? \`${s.moduleId}.${s.type}\` : s.kind`— the same string`SelectionKind.panelKey` exposes, so registration and dispatch cannot disagree.

Selecting anything replaces the whole value, so cross-clearing is structural rather than manual.

### Blocker C — `EditorRenderer`, `Canvas.svelte`, and `Toolbar.svelte` name every domain

- `EditorRenderer` (`src/rendering/EditorRenderer.ts:37-44`) constructs all seven renderers in its
  constructor including `LightRenderer`, and exposes `updateLights`, `setPreviewLight`,
  `setLightsVisible`, `setLightRadiusVisibility` as facade methods.
- `Canvas.svelte` (1052 lines) declares every renderer, every handler, and a `current*` mirror
  variable for each of the six selection stores as local `let`s, then wires them by hand in
  `onMount`.
- `Toolbar.svelte` (915 lines) hardcodes each tool button against the closed `Tool` union
  (`'select' | 'draw' | 'light' | 'door' | 'obstacle'`).

Target: `EditorRenderer` owns only the core layers and holds `SceneLayer[]` for the rest;
`Canvas.svelte` asks the registry for the active module's layers/handlers and loops;
`Toolbar.svelte` renders `registry.tools()`. This is the largest mechanical chunk of the work and
should be done _after_ A and B, because both simplify it substantially — in particular, the six
`current*` mirror variables collapse to one when selection lives in `Session`.

---

## 7. Document lifecycle

### 7.1 One decode pipeline

Today there are three entry points with three behaviors: `jsonImport.validateRoomState` validates
properly, `localStorage.loadFromLocalStorage` casts `JSON.parse(data) as RoomState` with three
ad-hoc shape-sniffing migrations and no validation, and `shareUrl.decodeShareData` delegates to
`importFromString`. Local storage is the weakest and will be the most common source of
pre-migration documents.

All three converge on one module:

```ts
// src/floorplan/persistence/documentCodec.ts

/** Normalizes module slices to defaults (§3.3). Synchronous. */
export function decodeDocument(raw: unknown): LoadedDocument;

/** Prunes slices that deep-equal a freshly-allocated `defaultData()` (§3.3, §3.4.1). */
export function encodeDocument(
  document: Readonly<RoomState>,
  carried: CarriedState,
  target: EncodeTarget
): unknown;

export type EncodeTarget =
  | { kind: 'file' }
  | { kind: 'local' }
  /** Single-module view; see §7.5. */
  | { kind: 'share'; moduleId: string };

/** What a load produces; consumed only by `sessionStore.open` (§3.2). */
export interface LoadedDocument {
  document: RoomState;
  carried: CarriedState;
  diagnostics: Diagnostics;
}
```

`decodeDocument` stays **synchronous** — it only touches eagerly-imported codecs (§5.1). Nothing in
the load path awaits a dynamic import, so `importFromString()` and `decodeShareData()` keep their
current signatures and no caller changes.

`encodeDocument` must be the only writer of the envelope. `jsonExport.createExportData` is folded
into it — today it independently reads `state.lights` and owns its own version constant. Taking
`carried` as a required positional parameter (rather than reading it from a store) means a save path
that forgets it fails to compile.

Pruning calls `codec.defaultData()` fresh at save time and never caches the baseline across calls —
a cached baseline is reachable from module code through the same reference that was normalized into
the document, which is the data-loss path described in §3.4.1(2).

**Merge precedence — `carried.quarantined` vs. live `modules`:**

| Rule                                     | Behavior                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `target: 'file'` / `'local'`             | Live slices encoded at `codec.schemaVersion`, defaults pruned; quarantined blobs merged back verbatim. |
| `target: 'share'`                        | **Quarantined blobs are omitted entirely**, along with all non-target live slices.                     |
| Same id in both maps                     | **Live wins.** Also a bug — assert in dev builds; `decodeDocument` puts each id in exactly one map.    |
| Target module is disabled or quarantined | **Not shareable.** The share UI blocks it; `encodeDocument` throws if asked.                           |

That last rule matters: a quarantined blob is by definition one this build could not decode, so it
cannot be compacted, validated, or meaningfully rendered by a viewer. Emitting a share link for it
would produce a URL that fails on open.

### 7.2 Failure policy

**Geometry is the shared asset; a broken module must never cost the user their room.** Only
geometry validation failure rejects the document.

| Case                                   | Action                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------- |
| Geometry invalid                       | **Reject the document.** Throw `ValidationError` as today.             |
| Module slice absent                    | Normalized to `codec.defaultData()` during decode (§3.3).              |
| Module slice `ok`                      | Live in `document.modules[id]`.                                        |
| Module slice `unsupported` (newer `v`) | Quarantine verbatim, disable module, warn: "saved by a newer version". |
| Module slice `invalid`                 | Quarantine verbatim, disable module, warn with the codec's message.    |
| No codec registered for the id         | Quarantine verbatim, no warning (expected in single-module builds).    |

Disabled means: the mode is not selectable, its tools/layers/panels are absent, no default is
materialized for it, and its blob is written back unchanged on save. The user can still edit geometry
and use the other module.

### 7.3 Versioning — two levels, and the existing collision

`ExportData.version: 1 | 2` already exists (`jsonExport.ts:5`), but it versions the _light-definition
envelope_, not the document schema. Overloading it for the modular shape would give one number two
meanings and make the migration matrix ambiguous.

Resolution — two independent, explicitly-named levels:

- **Envelope**: `version: 3` means modules-shaped. Readers for `1` and `2` are kept **permanently**;
  they parse the legacy flat shape and lift `lights` / `rafterConfig` into `modules.lighting`.
- **Per-module**: each blob carries its own `v`, owned and migrated by that module's codec. A module
  can revise its schema without touching the envelope version or any other module.

Legacy share URLs encode envelope 1 and 2. Those decoders are load-bearing forever, not transitional.

### 7.4 History and derived data

With §3.2 in place, history no longer diffs — `commit` pushes the pre-commit `RoomState` and its
label. Two rules remain, and both are now enforced structurally rather than by discipline:

**(a) Derived data must not enter the document.** Planks are a pure function of
(polygon, obstacles, `LayoutConfig`). Storing generated planks would put thousands of objects into
every one of 50 history snapshots. **Store the config; derive the layout.** The computed layout lives
in a memoized derived store computed from `session.document` and is never persisted, never cloned,
never diffed. This also gives correct undo granularity for free — undo steps back through user intent
("changed stagger to 1/3"), not through machine output.

Enforcement: `Session` has no field for derived data, and the layout output type is declared in
`runtime.ts`, which `codec.ts` may not import (§4) — so `ModuleCodec<T>`'s `T` cannot be it.

**(b) Undo stays global across the whole document, not per-module.** A single action can touch both
geometry and a module slice (dragging a wall reflows the plank layout's inputs), so per-module stacks
would either desync or need cross-stack coordination. Mitigation for the "undo did something I can't
see" problem: `commit` requires a label, `History` exposes `undoLabel` / `redoLabel`, and the UI names
what will be undone. Revisit only if cross-mode undo confusion shows up in real use.

### 7.5 Share URLs are module-aware

`generateShareUrl` always emits `#/viewer?d=...` and hardcodes lighting's payload shape. Target:

- New links emit `#/{moduleId}/viewer?d=...`. The module to open is in the path — not inferred from
  persisted UI state, which does not travel with the link.
- Legacy `#/viewer` remains a permanent alias for `#/lighting/viewer`.
- The share dialog picks the module explicitly, defaulting to the active mode.
- Sharing calls `compactForShare` on the target module and **omits other modules' slices entirely**
  — a share link is a single-module view, and the size budget (8000-char warning threshold) does not
  survive carrying both. The dialog says so when the document has more than one populated module.

---

## 8. Phasing

Each phase is independently shippable and leaves `main` green. Run `npm run test:run`,
`npm run type-check`, and `npm run lint` at every phase boundary.

Phases 3 and 4 divide cleanly: **phase 3 is the data plane, phase 4 is the UI plane.**

### Phase 0 — scaffolding (½ day)

- Add `docs/plans/` (this file).
- Add the import-boundary lint rule with the target directory layout allow-listed, initially with
  no directories to police. Landing the rule before the moves means each subsequent phase is
  validated as it lands.

### Phase 1 — session store + commit spine (4–5 days) ← **start here**

- Introduce `Session`, `sessionStore`, `commit` / `open` / `undo` / `redo` (§3.1–3.2), and the
  `Gesture` handle with the semantics in §3.2.1. `modules` starts as an empty opaque map; no module
  system yet.
- Keep `roomStore` as `derived(sessionStore, s => s.document)` so every read site and every Svelte
  template is untouched.
- **Convert all 29 writers in this phase — the §3.2 inventory is the checklist.** Making `roomStore`
  derived breaks every writer at once, including the 13 helper internals in `roomStore.ts`
  (`updateWallLength`, `moveWall`, `addDoor`, the obstacle operations, …). There is no partial
  landing: `roomStore.ts` cannot compile against a derived `roomStore` until its own bodies move to
  `commit`. Sequence within the phase: land `sessionStore` alongside the writable `roomStore` first,
  migrate writers, then flip `roomStore` to derived as the last commit.
- Replace `DragManagerCallbacks.onPauseHistory` / `onResumeHistory` with a `Gesture | null` held by
  `DragManager`: `startDrag` → `begin`, `commitDrag` → `commit`, `cancelDrag` → `cancel`. Route the
  drag operations' writes through `gesture.apply`.
- Wire the missing gesture exits: `pointercancel` and window `blur` currently have no path to
  `cancelDrag`, and under the new model a missed exit suppresses history until the next drag.
- Delete `statesAreEqual`, the `roomStore` subscription in `historyStore`, and the pause/resume
  primitives.
- `resetRoom()` becomes `open(emptyDocument())`.
- Add dev-mode deep-freeze on `open` and `commit` (§3.4.1) and fix the mutations it surfaces.
- **Tests:** the full §3.2.1 suite — including the returns-to-origin case that reference equality
  would miss — plus a per-drag-op test for one-undo-entry and live intermediate frames.
- **Risk:** the drag paths are the subtle ones. Verify per drag op that a wall drag lands as one undo
  entry, that the canvas updates on every intermediate frame, that a drag ending at its origin
  consumes no undo step, and that `cancelDrag` restores the entry snapshot without relying on
  `IDragOperation.cancel()` being correct.
- **Ships value alone:** removes the O(document) `JSON.stringify` on every emission, gives undo
  entries real labels, and fixes the load-pushes-undo bug that exists today.

**Why this before selection:** selection lives inside `Session`, so doing selection first means
doing it twice.

### Phase 2 — unified selection (2–3 days)

- Introduce the `Selection` union (§6B) as a field of `Session`, plus `defineSelection` /
  `SelectionKind` (§3.4).
- **Introduce a minimal panel registry here** — a plain `Map<string, ComponentType>` keyed by
  `panelKey` and populated statically in `App.svelte`. ~20 lines, no module system, no dynamic
  import. Phase 4 changes only where the map is _populated from_ (module manifests instead of a
  literal); the dispatch seam in `App.svelte` is written once, in this phase.
- Migrate call sites store-by-store, keeping derived shims (`selectedWallId = derived(session, …)`)
  so components convert incrementally rather than in one commit.
- Delete the shims and the six stores.
- **Risk:** `Canvas.svelte` mirrors each store into a local `current*` variable; those subscriptions
  must be converted together or the canvas will render against stale selection.
- **Ships value alone:** removes the manual cross-clearing bug class.

### Phase 3 — document restructure + persistence pipeline (4–5 days)

- Define `ModuleCodec<T>` / `ModuleBlob` / `DecodeResult<T>` in `floorplan/types/module.ts`, the
  opaque `ModuleSlices` type with `readModule` / `commitModule`, and the codec registry in
  `modules/codecs.ts`. No runtime manifest yet.
- Write `lighting/codec.ts` — the only module codec at this point.
- Build `documentCodec.ts` (§7.1) and route **all** entry points through it: `jsonImport`,
  `jsonExport`, `localStorage`, plus `shareUrl` on both sides. Every load ends in
  `sessionStore.open(loaded)`.
- Add `RoomState.modules` and `CarriedState`; move `lights`, `rafterConfig`, dead-zone and spacing
  config into `modules.lighting`; route lighting's writes through `commitModule`.
- Implement normalize-on-load / prune-on-save (§3.3), with the fresh-`defaultData()` baseline rule
  (§7.1) and the shared fresh-default contract test applied to every registered codec (§3.4.1).
- Envelope `version: 3` with permanent readers for 1 and 2 (§7.3).
- **Test first**, before changing any types: fixtures for envelope v1, v2, a future-version module
  blob, a corrupt module blob, and an unknown module id — asserting the migrated shape, the
  quarantine behavior, and **value-identical** round-trip of quarantined blobs (deep equality after
  a decode → encode → decode cycle). Not byte-identical: the blob has already been through
  `JSON.parse`, so key order, whitespace, string escapes, and numeric spelling are free to change.
  Preserving the JSON _value_ is the actual requirement and is what a future build needs to decode
  its own data successfully.
- Add a round-trip test for prune/normalize: load → visit a mode → save produces a
  value-identical document.
- **Risk:** share URLs in the wild encode envelope 1 and 2. Those readers are permanent.

### Phase 4 — runtime manifest + move lighting (4–5 days)

- Define `ModuleRuntime` and the full registry pairing codec + `loadRuntime`.
- Physically move lighting files under `src/modules/lighting/`; author `runtime.ts`.
- Refactor `EditorRenderer` to `SceneLayer[]`; refactor `Canvas.svelte` and `Toolbar.svelte` to
  drive off the registry; repoint the phase-2 panel map at module manifests.
- Turn on the boundary lint rules for real, including the codec/runtime isolation rule.
- **This phase proves the seam using the module that already works** — if the contract is wrong,
  it is wrong against known-good behavior with an existing test suite, not against new flooring code.

### Phase 5 — Studio shell + routing (1–2 days)

- Extend `routerStore` beyond `'editor' | 'viewer'` to `#/{module}`, `#/{module}/viewer`, plus a
  mode-picker landing route.
- Preserve legacy URLs permanently: bare `#/` and `#/viewer` resolve to lighting.
- Module-aware share links (§7.5).
- Lazy-load runtimes via dynamic `import()`; verify with a bundle-size check that the IES parser and
  heatmap shaders are absent from the initial chunk.

### Phase 6 — flooring module (scope TBD, largest phase)

- Types: `PlankSpec` (width, length, thickness), `LayoutConfig` (run angle, start corner, stagger
  rule, min end-cut, expansion gap, row offset pattern), `Transition`.
- `PlankLayoutEngine`: pure function of (polygon, obstacles, config) → planks + cut list + waste %.
  **Output is derived, never stored** (§7.4a) — memoized derived store, and the type is declared in
  `runtime.ts` so it is unreachable from the codec.
- `PlankRenderer`: **`THREE.InstancedMesh` from the start.** A 400 sqft floor at 7"×48" planks is
  ~200 planks; the existing renderers rebuild meshes on every store change, which is fine at ~20
  lights and is not fine at 200+ planks with per-plank hit-testing.
- Panels: layout config, plank spec, cut list / waste summary.
- Reuse `Obstacle` polygons as cutouts and `Door` positions as threshold candidates directly.

---

## 9. Risks

| Risk                                                                 | Mitigation                                                                                     |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Big-bang refactor stalls mid-way                                     | Six implementation phases plus scaffolding, each shippable; phases 1–3 stand alone.            |
| Phase 1 must convert all 29 writers atomically — no partial landing  | Reads untouched; inventory enumerated in §3.2; flip `roomStore` to derived last.               |
| Drag interactions regress on the pause/resume → gesture swap         | §3.2.1 pins the full state table; test per drag op for one entry + live frames.                |
| A leaked open gesture silently suppresses history                    | `begin` throws while one is open; `pointercancel` / `blur` exits wired in phase 1.             |
| Zero-motion or return-to-origin drags consume an undo step           | `commit()` does one structural comparison at close, not reference equality (§3.2.1).           |
| In-place mutation bypasses history, or drifts the prune baseline     | `Readonly<T>` at boundaries, dev deep-freeze, fresh-default contract test per codec (§3.4.1).  |
| Existing share URLs break                                            | Envelope 1/2 readers are permanent; fixture tests land before the type change.                 |
| Undecodable module data silently lost on save                        | Quarantine held in `CarriedState`; value-identical round-trip test in phase 3.                 |
| Prune-on-save drops a slice a user meant to keep                     | Prune only on exact deep-equality with `defaultData()`; round-trip test in phase 3.            |
| Codec bundle bloat defeats lazy loading                              | Lint rule bans `three` / `*.svelte` / `runtime.ts` imports from `codec.ts`; bundle check in 5. |
| `Canvas.svelte` (1052 lines) is a merge-conflict magnet              | Do phases 1–4 on short-lived branches; avoid parallel feature work in that file.               |
| Module contract is wrong                                             | Phase 4 validates it against lighting (known-good, tested) before flooring exists.             |
| History snapshots balloon with plank data                            | Structural: derived output has no field on `Session` and is unnameable from `codec.ts`.        |
| Plank rendering perf                                                 | `InstancedMesh` + spatial hit-testing from the first commit, not retrofitted.                  |
| Product focus dilution (lighting designers vs. flooring contractors) | Mitigate with branding and entry points in phase 5, not with a code split.                     |

---

## 10. Out of scope

- Monorepo / workspace migration (revisit against the triggers in §1).
- 3D flooring visualization.
- Server-side persistence or accounts.
- Renaming the `lumen_2d` package (cosmetic; do it if and when the Studio ships publicly).
