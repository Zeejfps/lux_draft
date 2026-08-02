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

A note on how this section was reached, because it matters for reading it. Earlier drafts answered
the drag problem with history _suppression_ — a pause flag, then a scoped `Gesture` handle. Both
produced a mode in which the document is being written while history is off, and each round of review
found another rule that mode needed. §3.2.1 removes the mode instead: drags never write the document.
The general lesson is worth keeping in view for the rest of the plan — **when a design accumulates
runtime guards, the guards are usually reporting that a state exists which should not**.

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

/** A snapshot and the name of the action that produced the change away from it. */
export interface HistoryEntry {
  document: RoomState;
  label: string;
}

export interface History {
  readonly past: readonly HistoryEntry[];
  readonly future: readonly HistoryEntry[];
}

/** Derived, not stored — labels must travel with their snapshots, not alongside the stacks. */
export const undoLabel = (h: History) => h.past.at(-1)?.label ?? null;
export const redoLabel = (h: History) => h.future[0]?.label ?? null;

/**
 * The exported shape. `DeepReadonly` — not bare `readonly` — because `Readonly<T>` is
 * shallow and `doc.walls.push(w)` would otherwise type-check. Mutable counterparts exist
 * only inside `sessionStore`, which is the sole constructor of these values.
 */
export interface Session {
  /** Committed. The only field history snapshots, autosave writes, and export reads. */
  readonly document: DeepReadonly<RoomState>;
  readonly carried: DeepReadonly<CarriedState>;

  /** Ephemeral. Never persisted, never undoable. */
  readonly selection: Readonly<Selection>;
  readonly interaction: DeepReadonly<Interaction>; // §3.2.1
  readonly diagnostics: DeepReadonly<Diagnostics>;

  readonly history: History;
}
```

The data lifetimes — _committed_, _carried_, _ephemeral_, _derived_ — become positions in a type
instead of conventions. Derived data gets no field at all: it lives in memoized derived stores
computed from `session.document` and has nowhere to be written to. The committed/ephemeral line is
the one §3.2.1 turns out to depend on entirely.

`history` snapshots `RoomState` only. Quarantine, diagnostics, and selection are siblings of the
document, so their exclusion from undo is structural — not a `readonly` marker that TypeScript
erases at compile time while `structuredClone` copies the field anyway.

**Labels are per-entry, not per-stack.** A pair of `undoLabel` / `redoLabel` fields alongside the
stacks can name the _next_ undo but cannot survive repeated undo/redo: after committing "Move wall"
then "Change ceiling height", undoing twice has to surface "Change ceiling height" and then "Move
wall" as redo labels in that order, and that information is not recoverable from two arrays of bare
`RoomState`. Pairing each snapshot with its label makes the transfer trivial:

```ts
const MAX_HISTORY = 50; // preserved from historyStore.ts:10

commit(label, fn):  const next = fn(current);
                    if (deepEqual(next, current)) return;          // no-op commits push nothing
                    past.push({ document: current, label });
                    if (past.length > MAX_HISTORY) past.shift();   // evict oldest
                    current = next; future = [];
undo():             const e = past.pop(); future.unshift({ document: current, label: e.label });
                    current = e.document;
redo():             const e = future.shift(); past.push({ document: current, label: e.label });
                    current = e.document;
```

The label rides with the entry across both stacks, so `undoLabel` / `redoLabel` are one-line derived
reads. Test with a mixed sequence: commit A, commit B, undo, undo, redo — asserting the label pair at
every step.

**The 50-entry cap is load-bearing and must not be lost in the rewrite.** `historyStore.ts:10` caps
`past` today; an unbounded stack retains whole document snapshots for the life of a session, which is
exactly the growth the module slices make worse.

Eviction is oldest-first from `past` only, and `undo`/`redo` never evict — they move entries between
the stacks, so **`past.length + future.length ≤ MAX_HISTORY`** is the real invariant. (Not "`future`
is bounded by `past`", which an earlier draft said and which is false: undo everything and `future`
is 50 while `past` is 0.) Tests: commit 51 times → `past.length === 50` with entry 1 gone; then undo
50 times → `past` 0, `future` 50, sum still 50.

### 3.2 There is exactly one way to write, and it is a commit

One store, and it does not expose `set` or `update`:

```ts
// src/floorplan/stores/sessionStore.ts
export const sessionStore = {
  subscribe,

  /** The only way a document enters the app. */
  open(loaded: LoadedDocument): void,

  /** The only way the document changes. One call → one snapshot → one history entry. */
  commit(label: string, fn: (doc: Readonly<RoomState>) => RoomState): void,

  /** Ephemeral (§3.2.1). Not undoable, not persisted, records no history. */
  setInteraction(next: Interaction): void,
  select(next: Selection): void,

  /**
   * Completes the active interaction: commits its result, pushes one history entry,
   * and returns to `idle` — in a single emission. §3.2.1.
   */
  finishInteraction(): boolean,

  /** Both reset `interaction` to `idle` atomically with the document swap. §3.2.1. */
  undo(): boolean,
  redo(): boolean,
};

/**
 * What the editor renders and what most code reads: the committed document with the
 * in-flight interaction previewed on top. Pure, derived, never persisted. §3.2.1.
 */
export const roomStore = derived(sessionStore, (s) => previewDocument(s.document, s.interaction));

/** What history, autosave, export, and share read. Never includes a preview. */
export const committedDocument = derived(sessionStore, (s) => s.document);
```

That is the whole write surface. There is no second write mode, no suppression flag, no scope to
open or close, and therefore no state in which a write is legal-or-not depending on hidden mode.

`open` constructs a whole new `Session` whose `history` is `{ past: [], future: [] }`. There is no
code path by which opening a document could push an undo entry, because opening is not a commit.
`carried` is replaced along with the document, so a previous document's quarantine cannot outlive it.
`selection` and `interaction` are reset in the same value, so neither stale ids nor a stale drag can
survive a swap.

`statesAreEqual` and its `JSON.stringify` of the entire document on every emission are deleted, not
optimized — history is now told what happened. (This resolves what earlier drafts filed as a
follow-up performance item; it comes free.)

**Subscription granularity.** One `Session` value means every pointer move during a drag
reconstructs it and notifies every `sessionStore` subscriber. Nothing may subscribe to `sessionStore`
directly except the narrow derived stores in this file — `roomStore`, `committedDocument`,
`selection`, `history`, `diagnostics`. Svelte's `derived` propagates on every parent emission, so
those stores each guard with a reference-equality check and only emit when their own slice actually
changed; a drag then wakes the renderer and the geometry panels, not the toolbar and the share
dialog. Components subscribe to the narrow stores, never to the session. Worth a lint rule if it
starts drifting.

**Every writer converts in one phase.** Making `roomStore` derived is not a gradual change: the
moment it loses `set`/`update`, every existing writer stops compiling. That is the desired property —
the compiler produces the migration checklist — but it means phase 1 must convert all 29 sites (14 in
`roomStore.ts`, 15 outside it), not just the ones outside `roomStore.ts`. Full inventory:

| Where                                                                                                                                                                    | Count | Becomes                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | -------------------------------------------------------------------------------- |
| `roomStore.ts` **drag-reachable** helpers — `updateVertexPosition`, `moveWall`, `updateDoor`, `updateObstacleVertexPosition`, `moveObstacle`                             | 5     | `commit(label, fn)`, called once at pointer-up — the per-frame caller disappears |
| `roomStore.ts` remaining helpers — `updateWallLength`, `insertVertexOnWall`, `deleteVertex`, `addDoor`, `removeDoor`, `addObstacle`, `updateObstacle`, `removeObstacle`  | 8     | `commit(label, fn)` — bodies are already `(state) => newState`                   |
| `roomStore.resetRoom`                                                                                                                                                    | 1     | `open(emptyDocument())`                                                          |
| `historyStore.undo` / `.redo`                                                                                                                                            | 2     | deleted with `historyStore`                                                      |
| Load paths — `App.svelte:124`, `ViewerPage.svelte:27,55`, `Toolbar.svelte:158`                                                                                           | 4     | `open(loaded)`                                                                   |
| `Canvas.svelte:616` — `onUpdateLightPositions` drag callback                                                                                                             | 1     | deleted; lighting drags preview via `Interaction` and commit once (§3.2.1)       |
| Ordinary edits — `settingsStore:22,28`, `PropertyPanel:32`, `LightPropertiesPanel:32,54`, `Canvas.svelte:574` (delete lights), `:667` (close room), `:709` (place light) | 8     | `commit(label, fn)`                                                              |

Under §3.2.1 every surviving row is the same conversion — a plain `commit` — because the per-frame
write callers no longer exist. The four `roomStore.set` load paths are the only ones that change
semantics, which is the point: they are exactly the sites that push a spurious undo entry today.
The real work of phase 1 is not this table; it is the six drag operations (§3.2.1 costs).

Read sites — the large majority, including every Svelte template and every
`get(roomStore)` — are untouched, because `roomStore` survives as a derived view.

### 3.2.1 In-flight interactions are ephemeral, not document writes

Only one thing in this codebase makes a single write mode look impossible: a drag changes the room
across many pointer events, and history must not record every frame. Earlier drafts answered that
with history suppression — first `pauseRecording`/`resumeRecording`, then a `Gesture` handle. Both
are the same shape: a mode in which the document is being written but history is switched off, and a
table of runtime rules about what is legal while that mode is active.

**The codebase already contains the better answer, applied to drawing but not to dragging.**

`DrawingHandler` changes the room across many pointer events too. It accumulates in `wallBuilder`,
pushes previews to the _renderer_ — `onUpdateDrawingVertices`, `onSetPhantomLine`,
`onSetPreviewVertex` — and touches the store exactly once, at `onCloseRoom`
(`DrawingHandler.ts:49-137`). It never pauses history, because it never writes anything history would
have to ignore.

`WallDragOperation` does the opposite. `update()` calls `onMoveWall` → `roomStore.update` on every
pointer move (`WallDragOperation.ts:90`), `cancel()` restores by writing again (`:104`), and
`commit()` only flips a flag (`:93-98`). But look at `:41-88`: it already captures `originalStart` /
`originalEnd` at drag start and computes the result as a pure function of (original geometry, pointer
position, axis lock, snap config). **The single impure line is 90**, where it calls a store-writing
callback instead of returning the value it just computed.

So make the interaction a value, and the previewed document a pure function of it.

**One authoritative drag representation.** There is a fork here that must be closed explicitly,
because taking both branches would duplicate drag logic between the operation classes and
`applyDrag` and let preview and commit drift apart. The division of labour is:

- **Operations resolve pointer input into target values.** Axis lock, snapping, guides, constraints
  — the geometry work `WallDragOperation:63-88` already does well. They do not touch documents.
- **`applyDrag` puts those values into a document.** It is the only code that edits for a drag, and
  both the preview and the pointer-up commit call it.

```ts
// src/floorplan/types/interaction.ts

export type DragTarget =
  | { kind: 'vertex'; index: number }
  | { kind: 'wall'; id: string }
  | { kind: 'door'; id: string }
  | { kind: 'obstacle'; id: string }
  | { kind: 'obstacleVertex'; obstacleId: string; index: number }
  | { kind: 'moduleEntity'; moduleId: string; ids: string[] };

/**
 * What the operation resolved for the current pointer. ABSOLUTE, never a delta —
 * so applying it is idempotent and independent of the document it lands on.
 */
export type DragResolution =
  | { kind: 'points'; positions: ReadonlyMap<string, Vector2> }
  | { kind: 'segment'; start: Vector2; end: Vector2 }
  | { kind: 'scalar'; value: number }; // e.g. a door's offset along its wall

export interface DraggingInteraction {
  kind: 'dragging';
  target: DragTarget;
  resolved: DragResolution;
  label: string;
}

export type Interaction =
  | { kind: 'idle' }
  | { kind: 'drawing'; vertices: readonly Vector2[]; cursor: Vector2 | null }
  | DraggingInteraction
  | { kind: 'measuring'; from: Vector2; to: Vector2 | null };

/** Pure. The single implementation of "what this drag does to a document". */
export function applyDrag(doc: DeepReadonly<RoomState>, d: DraggingInteraction): RoomState;

/** Pure. Dispatches to `applyDrag` for 'dragging'; returns `doc` unchanged for 'idle'. */
export function previewDocument(doc: DeepReadonly<RoomState>, i: Interaction): RoomState;
```

Operations therefore return a `DragResolution`, not a document and not a callback invocation. Their
`update()` signature becomes `(ctx: DragUpdateContext) => DragResolution`, which is a smaller change
than it sounds: `WallDragOperation:81-90` already computes `{ newStart, newEnd }` and then throws it
at a callback.

**Resolutions are absolute, not deltas.** A delta-based resolution applied twice moves twice; an
absolute one is idempotent, which makes the preview and the commit trivially equal and removes a
whole class of ordering bug. Operations already capture `originalStart` / `originalEnd` at drag
start precisely so they can compute absolute results.

Contract test, per drag kind: drive an operation through a pointer sequence, then assert
`previewDocument(committed, dragging)` is **deeply equal** to the document produced by the pointer-up
commit. Preview and commit cannot disagree without failing this.

#### Completing an interaction is one atomic transition

```ts
// startDrag / updateDrag — ephemeral only, one emission each
setInteraction({ kind: 'dragging', target, resolved, label });

// commitDrag — ONE session transition: document, history, and interaction together
finishInteraction();

// cancelDrag — the document was never touched
setInteraction({ kind: 'idle' });
```

`finishInteraction()` is a distinct store operation, not `commit(...)` followed by
`setInteraction(...)`. Two emissions would leave an observable intermediate state in which the
document already contains the drag's result while `interaction` still describes it — so `roomStore`
would derive the drag over a document that already has it applied. Absolute resolutions make that
frame harmless rather than wrong, but it is still a redundant emission and an incoherent `Session`,
which is exactly what §3.1 exists to prevent.

The same rule applies to every transition that changes the committed document:

| Operation             | Interaction afterwards                                           |
| --------------------- | ---------------------------------------------------------------- |
| `finishInteraction()` | `idle`, in the same emission as the commit and the history push  |
| `undo()` / `redo()`   | `idle`, set **atomically with** the document swap — see below    |
| `open(loaded)`        | `idle`, with selection cleared, in the one `Session` replacement |
| `commit(label, fn)`   | Unchanged — an ordinary commit is not part of an interaction     |

**Undo and redo must clear the interaction, not merely coexist with it.** An earlier draft said undo
during a drag "is well-defined because there is no in-flight document write to conflict with". That
was wrong in a different way: if the interaction survives, the preview is immediately re-applied to
the _restored_ document, using a `DragTarget` whose ids or vertex indices were resolved against the
pre-undo document. Undoing the deletion of the very wall being dragged, or undoing a vertex
insertion that shifts indices, then previews against entities that no longer mean the same thing.
Clearing to `idle` in the same transition removes the question.

Tests: drag an entity and undo mid-drag; undo to a snapshot that does not contain the dragged
entity; redo the same; assert in each case that the interaction is `idle` and the rendered document
equals the restored snapshot exactly.

#### What this deletes

This is not a smaller version of the gesture design. It removes the concept:

| Removed                                                                         | Because                                                                             |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `Gesture`, `begin`, `apply`, `applyModule`, `transact`, and their rules table   | Nothing writes the document mid-interaction, so nothing needs a scope               |
| "`commit` throws while a gesture is open", and the other five runtime guards    | There is no mode in which a commit is illegal                                       |
| `transact` sync-only / async-rejection / nesting rules                          | No callback scope exists                                                            |
| Gesture-leak hazard; `pointercancel` / `blur` as a _history_ risk               | A missed exit leaves a stale preview, not a silently suppressed history             |
| `pauseRecording` / `resumeRecording` / `isRecordingPaused` / `stateBeforePause` | No successor concept at all                                                         |
| `IDragOperation.cancel()` in all six operations                                 | Cancel is `setInteraction({ kind: 'idle' })`; the document was never modified       |
| The pure-transform-plus-two-runners split for six dual-use edits                | `moveWall` is just `commit(...)` again; the drag path no longer calls it per frame  |
| `withModule` / `commitModule` vs `applyModule`                                  | One `commitModule`. Module drags preview through `Interaction` like everything else |
| No-op detection as a gesture-close concept                                      | Falls out of `commit` skipping a transform that returns a value-equal document      |

The runtime guards that survive are the ones that are genuinely runtime: decoding stored blobs
(§5.1), the quarantine/live id collision assert (§7.1), refusing to share an undecodable module
(§7.1), dev deep-freeze (§3.4.1), and the fresh-defaults contract test. Those are parsing and JS
mutability, not mode.

#### What it costs, honestly

- **Six drag operations change shape**: `update()` returns its computed result instead of calling a
  writing callback, and `cancel()` is deleted. `WallDragOperation` is the easy case (delete `:90`,
  `:100-108`, return the value); `GrabModeDragOperation` (302 lines) is the one to scope carefully.
  ~1000 LOC of operations touched, mechanically.
- **`DragManagerCallbacks` collapses.** The seven `on*` writing callbacks become one return type. This
  is a simplification, but it is a wide edit across `Canvas.svelte`'s `onMount` wiring.
- **Derived stores must read `roomStore` (previewed), not `committedDocument`.** Dead zones, spacing
  warnings, and lighting stats update live during a drag today; pointing them at the committed
  document would freeze them mid-gesture. Persistence, history, export, and share read
  `committedDocument`. Getting this backwards in either direction is the one new mistake this design
  makes available — call it out in review.
- **`previewDocument` runs per frame.** It rebuilds the touched wall and the walls array — the same
  work `roomStore.update` did per frame today, so no regression, but it must stay allocation-light.

#### Interaction state is a tagged union, which removes its own invalid states

`WallDragOperation` currently encodes a two-state machine in five nullable fields — `_isActive`,
`wallId`, `originalStart`, `originalEnd`, `startPosition` — and opens `update()` with a six-clause
guard checking them (`:53-61`). Most of the 32 representable combinations are meaningless. As an
`Interaction` variant, the drag's data exists only in the `dragging` case, the guard disappears, and
"active but missing its origin" stops being expressible.

Tests: a drag that returns to its origin commits nothing; cancel leaves the committed document
byte-identical; `undo` during a drag is well-defined (it commits nothing and undoes the previous
entry, because there is no in-flight document write to conflict with); every drag op previews live
and commits exactly one labeled entry; the mixed-label undo/redo sequence from §3.1.

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

/** Pure: returns a new document with this module's slice replaced. No store access. */
export function withModule<T>(
  doc: Readonly<RoomState>,
  codec: ModuleCodec<T>,
  fn: (prev: Readonly<T>) => T
): RoomState;

/** Commits a slice edit as one history entry. The only way module data changes. */
export function commitModule<T>(
  codec: ModuleCodec<T>,
  label: string,
  fn: (prev: Readonly<T>) => T
): void;
```

Call sites read `readModule(doc, lightingCodec)` and get `LightingData`, not `unknown`. The id string
is written once, in the codec.

**Module data gets dragged too, and needs no special case.** Lighting's `onUpdateLightPositions`
rewrites every selected fixture's position on each pointer move (`Canvas.svelte:615-623`), and once
`lights` lives in `modules.lighting` that is a slice write. Flooring will want the same for a
draggable layout origin and for transitions. Under §3.2.1 these are ordinary previews: the drag
lives in `Interaction`, `previewDocument` routes the `dragging` case through `withModule` to produce
the previewed slice, and pointer-up calls `commitModule` once. There is no second module-write API —
`withModule` is exported only so a module can compose several slice edits into one commit.

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

- **`DeepReadonly` at every exported boundary** — `Session`, `readModule`, `ModuleContext`,
  `SceneLayer.update`, `ToolDescriptor.enabled` (§3.1, §5.2). This is the primary defense, not a
  first line: bare `Readonly<T>` is shallow and would let `doc.walls.push(w)` type-check. Mutable
  counterparts exist only inside `sessionStore`, which is the sole constructor of these values.
- **Deep-freeze in development, as a backstop for the gaps `DeepReadonly` cannot close** — data
  arriving from `JSON.parse`, `structuredClone` results, and any `as` cast. `open`, every `commit`,
  and every `defaultData()` result pass through a recursive `Object.freeze` under
  `import.meta.env.DEV`. For that to actually vanish from production the call must sit behind a
  statically eliminable branch — a bare `if (import.meta.env.DEV)` that Vite replaces with `false`
  and the minifier drops — and the freeze helper must have no retained side effects (no registry of
  frozen objects, no logging). A `DEV &&`-guarded expression assigned to nothing, or a helper that
  memoizes what it froze, defeats elimination and ships the cost. Existing helper bodies already
  build new objects (`{ ...state, walls: [...] }`), so the expected number of violations is small.
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
| Multi-step drags must pause/resume history         | Drags never write the document; they are ephemeral previews (§3.2.1)   |
| Drag cancel must correctly undo its own writes     | Cancel is `setInteraction({kind:'idle'})`; there was nothing to undo   |
| Interaction state must be internally consistent    | `Interaction` is a tagged union; per-variant fields only               |

Costs, stated honestly:

- One large mechanical pass over **all 29 write sites** (§3.2), which cannot be split across phases —
  the moment `roomStore` becomes derived, every writer breaks at once. Under §3.2.1 these are all the
  same conversion, so it is bulk, not difficulty.
- **The six drag operations change shape** — `update()` returns a value instead of calling a writing
  callback, `cancel()` is deleted, and `DragManagerCallbacks`' seven writing callbacks collapse into
  a return type. This is the real work of phase 1 and the only part that is not mechanical. In
  exchange it deletes more code than it adds.
- `previewDocument` runs per frame — the same work the per-frame `roomStore.update` did today, so no
  regression, but it must stay allocation-light.
- One deep-equal comparison per commit, and one per module slice on save (cheap — slices are small by
  construction, since output is never stored).
- `Session` is a wide object that every write reconstructs; structural sharing makes this a handful
  of allocations per commit.
- **One new mistake becomes available**: reading `committedDocument` where `roomStore` (previewed) is
  meant, or the reverse. Derived visuals must read the preview or they freeze mid-drag; persistence
  must read committed or it saves half a gesture. Both are one-line errors — flag them in review.

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

  /** Fresh slice for a document that has none. Cheap, pure, and freshly allocated (§3.4.1). */
  defaultData(): T;

  /** Decode a stored blob. Never throws — returns a status. */
  decode(blob: ModuleBlob): DecodeResult<T>;

  /**
   * Strip derived/non-essential fields for share URLs. Defaults to identity.
   * MUST return a valid `T` at the current `schemaVersion` — see below.
   */
  compactForShare?(data: Readonly<T>): T;
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

**`compactForShare` returns `T`, not `unknown`, and this is load-bearing.** A compacted payload is
written into a share URL at the current `schemaVersion` and is read back by the ordinary
`decodeDocument` path — there is no separate share decoder. If compaction were free to emit an
arbitrary shape, it could produce a link that the module's own `decode` rejects, and the failure
would appear as a quarantined slice on the recipient's machine rather than as a bug on the sender's.
Typing the return as `T` states the requirement; the contract test enforces it: for every registered
codec, `decodeDocument(encodeDocument(doc, carried, { kind: 'share', moduleId }))` must succeed with
status `ok`, and the essential semantics (§7.3a: definitions, ids referenced by fixtures) must
survive. The alternative — a separate share schema with its own version — buys nothing here and
doubles the migration matrix.

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
  enabled?: (doc: DeepReadonly<RoomState>) => boolean;
}

export interface SceneLayer {
  id: string;
  update(doc: DeepReadonly<RoomState>, selection: Readonly<Selection>): void;
  setVisible(v: boolean): void;
  dispose(): void;
}

/** What a runtime is given. Capabilities, not stores. */
export interface ModuleContext {
  commit<T>(codec: ModuleCodec<T>, label: string, fn: (prev: Readonly<T>) => T): void;
  select(next: Selection): void;
  setInteraction(next: Interaction): void;
  read<T>(codec: ModuleCodec<T>): Readonly<T>;
  readonly document: DeepReadonly<RoomState>;
}
```

**Every document a module sees is deep-readonly, and `ModuleContext` hands out operations rather
than the session store.** A runtime that receives a mutable `RoomState` — or the store itself — can
edit outside `commit` and defeat the central invariant from a directory the core cannot police.
`DeepReadonly` makes that a compile error rather than a review item.

`SceneLayer` is deliberately the shape the existing renderers almost have already — they all expose
`update(...)`, `setVisible(...)`, `dispose()`. The change is narrowing `update` to
`(doc, selection)` so `EditorRenderer` can hold a `SceneLayer[]` and loop, instead of naming each
renderer as a field with a bespoke method (`updateLights`, `updateDoors`, `updateObstacles`).

One consequence to watch: `update(doc, selection)` asks every layer to re-derive from the whole
document on every change. That is fine for lighting and is what the renderers effectively do today,
but a plank layout is expensive enough that a naive implementation would recompute on unrelated edits.
`SceneLayer` may therefore declare a selector — `inputs?: (doc) => unknown` — with the shell skipping
`update` when the selected inputs are reference-equal to the previous call. Add it when flooring
needs it, not before; noted here so the interface has room.

### 5.3 Runtime activation is a state machine with an ownership rule

`loadRuntime()` is asynchronous, while mode switches, route changes, and document opens are not. Left
unspecified this produces leaked `THREE` resources and handlers wired to a mode the user already
left. The registry owns a per-module record:

```ts
type RuntimeState =
  | { status: 'unloaded' }
  | { status: 'loading'; token: number; promise: Promise<ModuleRuntime> }
  | {
      status: 'active';
      runtime: ModuleRuntime;
      layers: SceneLayer[];
      handlers: IInteractionHandler[];
    }
  | { status: 'failed'; error: Error };
```

Rules:

- **Dedup.** A second `activate()` while `loading` returns the in-flight promise. `import()` is
  already idempotent, but the layer/handler construction that follows it is not.
- **Generation token.** Every activation increments a counter. When a load resolves, the registry
  compares its token against the current one; a stale resolution constructs nothing and disposes
  nothing, because it never built anything. This is what makes "switch modes twice quickly" safe.
- **Ownership.** The registry constructs layers and handlers, and the registry disposes them —
  modules never dispose their own. Deactivation calls `dispose()` on every layer in reverse
  construction order and unregisters the handlers. `open(loaded)` deactivates the active module
  before swapping documents, so no layer ever sees two unrelated documents.
- **Caching.** The resolved module _record_ is cached; layers and handlers are **not**. They bind to
  a `THREE.Scene` and a `ModuleContext` and are rebuilt per activation. Caching them is the
  straightforward way to leak a scene.
- **Failure is session-scoped and does not touch data.** A runtime that fails to load or throws
  during construction moves to `failed`, and the module is disabled for the session with a
  diagnostic. Its slice stays decoded, live, and **is written back normally on save** — a runtime
  failure is not a decode failure, and must not quarantine valid data (§7.2).
- **Concurrency bound.** Only one module is active at a time in the current product shape (one mode
  visible). If that changes, the state machine is per-module already.

Tests, in phase 5: activate/deactivate/activate leaves zero orphaned scene children; a mode switch
mid-load discards the stale resolution; a rejected `loadRuntime` disables the mode, surfaces the
error, and still round-trips the module's data through save.

### 5.4 Registration validates and fails fast

The design depends on a lot of unique strings. A duplicate does not fail loudly on its own — it
silently shadows, and the failure surfaces later as the wrong codec decoding a slice or a panel
rendering for the wrong selection. Registration therefore throws on:

| Check                                     | Why                                                |
| ----------------------------------------- | -------------------------------------------------- |
| Duplicate module id                       | Second codec would shadow the first for that slice |
| `runtime.id !== codec.id`                 | Pairs the wrong runtime to a slice                 |
| Duplicate tool id, layer id, or panel key | Silent overwrite in the toolbar / dispatch map     |
| Tool id not namespaced with the module id | Guarantees the above cannot collide across modules |
| Shortcut already bound                    | See precedence below                               |

Shortcut precedence is explicit rather than registration-order: **core shortcuts win over module
shortcuts, and a conflict between two modules is a registration error.** Since only one module is
active at a time, a module-vs-module conflict is detectable at registration even though it could
never fire — failing then is better than failing when a user finally installs both.

These live in a shared registry contract test that every module is run through, so a new module
inherits the checks rather than re-deriving them.

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
flooring. So do the custom light definitions the fixtures reference, which are a third payload with
no home in the current design and their own correctness bug (§7.3a). `ceilingHeight` stays on the
core document (it is a room property), but note it is only _consumed_ by lighting today.

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
| Runtime failed to load (§5.3)          | **Data stays live and saves normally.** Mode unavailable this session. |

That last row is a distinction worth keeping sharp: a runtime failure is a UI failure, not a data
failure. The slice decoded fine, so it is written back through the normal encode path at the current
`schemaVersion`. Only decode failures quarantine.

Disabled means: the mode is not selectable, its tools/layers/panels are absent, no default is
materialized for it, and its blob is written back unchanged on save. The user can still edit geometry
and use the other module.

#### Quarantined data can go stale against edited geometry

Preserving a blob verbatim while the user reshapes the room means a future build may reopen data that
was authored for a different polygon. A flooring layout computed for the old room is not merely
outdated — its expansion gaps and cut list are wrong in a way that looks authoritative.

Three options were considered:

| Option                                   | Verdict                                                                                                                      |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Block geometry edits while quarantined   | No — inverts §7.2's premise. The room is the shared asset; a module this build cannot even parse must not hold it hostage.   |
| Stamp a marker into the quarantined blob | No — we cannot parse it, so we cannot safely modify it. Editing an opaque blob is how "preserved verbatim" stops being true. |
| **Record the drift beside the blob**     | **Yes.**                                                                                                                     |

`CarriedState` gains a geometry fingerprint captured at load — a cheap structural hash of walls,
obstacles, and `isClosed`. On save, if the fingerprint no longer matches, the envelope records
`geometryChangedSinceLoad: true` **next to** the quarantined blob, never inside it. The reading build
gets an explicit signal that the data predates the current room and can decide for itself whether to
recompute, warn, or discard.

In the app, the diagnostic escalates: a quarantined module's warning gains "the room has been edited
since this data was saved" on the first geometry commit. Tests: edit geometry with a quarantined
slice present, save, and assert the blob is value-identical and the flag is set; edit nothing and
assert the flag is absent.

This is a product decision as much as a data one, and it is the conservative branch — we never
silently discard a user's work, and we never let unparseable data freeze the editor.

### 7.3 Versioning — two levels, and the existing collision

`ExportData.version: 1 | 2` already exists (`jsonExport.ts:5`), but it versions the _light-definition
envelope_, not the document schema. Overloading it for the modular shape would give one number two
meanings and make the migration matrix ambiguous.

Resolution — two independent, explicitly-named levels:

- **Envelope**: `version: 3` means modules-shaped. Readers for `1` and `2` are kept **permanently**;
  they parse the legacy flat shape and lift `lights`, `rafterConfig`, **and `lightDefinitions`** into
  `modules.lighting` (§7.3a).
- **Per-module**: each blob carries its own `v`, owned and migrated by that module's codec. A module
  can revise its schema without touching the envelope version or any other module.

Legacy share URLs encode envelope 1 and 2. Those decoders are load-bearing forever, not transitional.

### 7.3a Referenced assets — custom light definitions

The envelope has a third payload the rest of this plan did not account for, and it does not fit any
existing category. `ExportData.lightDefinitions` (`jsonExport.ts:5-9`) carries custom fixture
definitions; `state.lights[].definitionId` references them. It is neither document geometry nor an
opaque carried blob nor derived output — it is a **referenced asset library**, and today it is
handled as a global side effect:

- `lightDefinitions` is a global `writable` seeded from `DEFAULT_LIGHT_DEFINITIONS` plus customs read
  from its **own separate localStorage key** (`lightDefinitionsStore.ts:32-42`).
- Export embeds only the definitions actually referenced by this room and only those whose id starts
  with `custom-` (`jsonExport.ts:31-49`) — built-ins travel by id alone.
- Import calls `mergeLightDefinitions`, which adds only ids not already present
  (`lightDefinitionsStore.ts:105-112`) — **existing wins**.

That last rule is a live bug, not just an awkward fit. Open a share link whose `custom-abc` differs
from your local `custom-abc` and the incoming definition is silently dropped; the fixtures then
render with your photometry instead of the sender's. It also makes `decodeDocument` impure — a
decode would mutate a global store as a side effect, which the §7.1 pipeline explicitly must not do.

**Decision: definitions referenced by a document belong to the document.**

```ts
export interface LightingData {
  fixtures: LightFixture[];
  rafterConfig: RafterConfig;
  deadZone: DeadZoneConfig;
  spacing: SpacingConfig;
  /** Closure of non-builtin definitions referenced by `fixtures`. Built-ins resolve by id. */
  definitions: LightDefinition[];
}
```

Rationale: `definitionId` is a document-internal reference, and a document that renders differently
depending on which machine opens it is broken. Making the closure part of `LightingData` is also the
minimal change to what is already on disk — the current format embeds exactly this closure, so v2
files migrate by moving the array, not by recomputing it.

Consequences, all of which resolve open questions rather than adding new rules:

- `decodeDocument` becomes pure. It moves `exportData.lightDefinitions` into
  `modules.lighting.definitions` and calls nothing.
- The global store is **demoted to a library** — it backs the fixture picker and keeps its own
  localStorage key. It is app state, not document state, and never round-trips through the document.
- Adopting definitions into the library becomes an explicit post-load step, not a decode side
  effect: after `open`, offer any unknown incoming definitions to the library. Same user-visible
  outcome as today, but the decode path no longer mutates globals.
- `resolveDefinition(id)` checks the document's `definitions` first, then the library. The document's
  copy wins, which is the reverse of today's precedence and is the fix for the share-link bug.
- `compactForShare` keeps the closure — dropping it would produce a link that renders wrong on any
  machine but the sender's.

**Alternative considered:** leave definitions global and carry them in `CarriedState`. Rejected —
`definitionId` would then reference data outside the document, so undo, export, and share would each
need their own rule for keeping the two in sync, and the collision bug would survive.

Phase 3 fixture, non-optional: a v2 file with one `custom-` definition referenced by a fixture,
asserting the definition survives decode → encode → decode with its photometry intact, and that a
_conflicting_ local definition of the same id does not override it.

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

The split points are deliberate: **1a is interaction, 1b is state, 3a/3b are the data plane
(infrastructure then live conversion), 4 is the UI plane.** Each of 1a, 1b, 2, and 3a is worth
landing even if the next one never does.

### Phase 0 — scaffolding (½ day)

- Add `docs/plans/` (this file).
- Add the import-boundary lint rule with the target directory layout allow-listed, initially with
  no directories to police. Landing the rule before the moves means each subsequent phase is
  validated as it lands.

### Phase 1a — drag operations become pure previews (3–4 days) ← **start here**

Shippable on its own against the _current_ stores, so phase 1b inherits a codebase that already has
a single write mode.

**Store topology, which is the part that has to be right.** Note that `roomStore` is _already_ the
live view today — drags write to it, which is why 49 read sites across 20 files see live geometry
during a gesture. Preserving that meaning for `roomStore` is what keeps every reader untouched:

```ts
// 1a: the writable is renamed and demoted; `roomStore` keeps its name and its live meaning.
const committedRoom = writable<RoomState>(...);          // was `roomStore`; writers point here
export const interaction = writable<Interaction>({ kind: 'idle' });
export const roomStore = derived(                        // same name, same live semantics
  [committedRoom, interaction],
  ([$doc, $i]) => previewDocument($doc, $i)
);
```

- **Writers** (all 29, §3.2) get a mechanical rename: `roomStore.update` → `committedRoom.update`.
  This is a rename, not the commit migration — no labels, no `sessionStore`, no history rework. That
  is 1b's job.
- **Readers** change in exactly zero places. They keep `roomStore` and keep seeing live drags.
- **Persistence, autosave, and `historyStore`** are repointed to `committedRoom` — a small
  enumerable set, and the only sites that must _not_ see previews.
- In 1b, `committedRoom` is absorbed into `sessionStore`, `roomStore` re-points to the session's live
  view, and `committedDocument` is exported for the persistence set. Readers are untouched again.

The work itself:

- Add `Interaction` (tagged union) and `previewDocument` / `applyDrag` (§3.2.1) as pure functions.
- Convert the six operations in `src/interactions/operations/` so `update()` returns its computed
  result instead of calling a writing callback, and delete their `cancel()` implementations.
  `WallDragOperation` first — it is the smallest and already pure apart from `:90`.
  `GrabModeDragOperation` (302 lines) last.
- Collapse `DragManagerCallbacks`' seven writing callbacks into a return type; delete
  `onPauseHistory` / `onResumeHistory` and the `historyStore.pauseRecording` / `resumeRecording`
  primitives entirely.
- `commitDrag` calls the existing `roomStore.ts` helper once (`moveWall(...)`, `updateDoor(...)`, …)
  instead of the op calling it per frame. The helpers are unchanged in this phase.
- Wire `pointercancel` and window `blur` to `cancelDrag` — not wired today.
- **Tests:** each drag op previews live, writes the committed document exactly once, writes nothing
  when it ends at its origin, and leaves the committed document untouched on cancel.
- **Ships value alone:** removes history suppression from the codebase, makes drag cancel correct by
  construction, and stops autosave from ever capturing a mid-drag document.

**If the rename churn is unwelcome, merge 1a and 1b** into one 6–8 day phase and go straight to
`sessionStore`. The split is worth it mainly because 1a is testable against the existing history
implementation, which makes the drag rewrite verifiable before the history rewrite lands.

### Phase 1b — session store + commit spine (3–4 days)

- Introduce `Session`, `sessionStore`, `commit` / `open` / `undo` / `redo` / `setInteraction` /
  `select` / `finishInteraction` (§3.1–3.2). `modules` starts as an empty opaque map; no module
  system yet.
- Move drag completion from 1a's two-step (`helper(...)` then clear interaction) to the atomic
  `finishInteraction()`, and make `undo`/`redo` clear the interaction in the same emission (§3.2.1).
- Add the narrow derived stores (`roomStore`, `committedDocument`, `selection`, `history`,
  `diagnostics`), each guarded by reference equality; nothing else subscribes to `sessionStore`.
- Re-point `roomStore` (still the live derived view) and `committedRoom` at `sessionStore`; export
  the latter as `committedDocument`. Readers are untouched for the second time.
- **Convert all 29 writers in this phase — the §3.2 inventory is the checklist.** Making `roomStore`
  derived breaks every writer at once, including the 13 helper internals in `roomStore.ts`. There is
  no partial landing: `roomStore.ts` cannot compile against a derived `roomStore` until its own
  bodies move to `commit`. Sequence: land `sessionStore` alongside the writable `roomStore`, migrate
  writers, flip `roomStore` to derived last.
- Delete `statesAreEqual` and the `roomStore` subscription in `historyStore`.
- `resetRoom()` becomes `open(emptyDocument())`.
- Add dev-mode deep-freeze on `open` and `commit` (§3.4.1) and fix the mutations it surfaces.
- **Tests:** the mixed-label sequence from §3.1 (commit A, commit B, undo, undo, redo, asserting the
  label pair at every step); commit 51 times and assert the stack holds 50 with entry 1 evicted, then
  undo 50 and assert `past + future` is still 50; load pushes no undo entry; `open` clears interaction
  and selection; undo/redo mid-drag clears the interaction atomically, including when the restored
  snapshot no longer contains the dragged entity (§3.2.1).
- **Risk:** breadth, not depth — 29 sites, all the same conversion, in one landing.
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

### Phase 3a — codec infrastructure and migration fixtures (3–4 days)

No live data moves in this phase. It builds the pipeline and proves it against fixtures while
lighting still reads `RoomState.lights`, so 3b lands against a tested decoder rather than an
untested one.

- Define `ModuleCodec<T>` / `ModuleBlob` / `DecodeResult<T>` in `floorplan/types/module.ts`, the
  opaque `ModuleSlices` type with `readModule` / `commitModule` / `withModule`, and the codec
  registry in `modules/codecs.ts`. No runtime manifest yet.
- Write `lighting/codec.ts` against the target `LightingData` shape (§7.3a), unused for now.
- Build `documentCodec.ts` (§7.1): envelope `version: 3`, permanent readers for 1 and 2 (§7.3),
  quarantine, normalize-on-load / prune-on-save (§3.3) with the fresh-`defaultData()` baseline rule.
- The shared codec contract tests, which every future module inherits: fresh defaults (§3.4.1),
  share round-trip (§5.1), registration uniqueness (§5.4).
- **Fixtures, written before anything reads them:** envelope v1; v2; **a v2 file with a referenced
  `custom-` light definition, plus a conflicting local definition of the same id** (§7.3a); a
  future-version module blob; a corrupt module blob; an unknown module id. Assert the migrated shape,
  the quarantine behavior, the geometry-drift flag (§7.2), and **value-identical** round-trip of
  quarantined blobs (deep equality after decode → encode → decode). Not byte-identical: the blob has
  already been through `JSON.parse`, so key order, whitespace, string escapes, and numeric spelling
  are free to change. Preserving the JSON _value_ is the requirement, and is what a future build
  needs to decode its own data.
- **Ships value alone:** the v1/v2 readers and their fixtures are permanent assets regardless of what
  happens next.

### Phase 3b — move lighting data into the module slice (3–4 days)

- Add `RoomState.modules` and `CarriedState`; move `lights`, `rafterConfig`, dead-zone and spacing
  config into `modules.lighting`; route lighting's writes through `commitModule`, and its drag
  preview through `previewDocument`'s `dragging` case like any other drag (§3.4).
- Move referenced custom light definitions into `LightingData.definitions` (§7.3a); demote the global
  `lightDefinitions` store to a picker library; replace the `mergeLightDefinitions` decode side
  effect with an explicit post-`open` adoption step; make `resolveDefinition` prefer the document's
  copy.
- Route **all** entry points through `documentCodec`: `jsonImport`, `jsonExport`, `localStorage`,
  plus `shareUrl` on both sides. Every load ends in `sessionStore.open(loaded)`.
- Add the round-trip test for prune/normalize: load → visit a mode → save produces a value-identical
  document.
- **Risk:** share URLs in the wild encode envelope 1 and 2. Those readers are permanent — but they
  were already proven in 3a, which is the point of the split.

### Phase 4 — runtime manifest + move lighting (4–5 days)

- Define `ModuleRuntime`, `ModuleContext`, and the full registry pairing codec + `loadRuntime`.
- Implement the activation state machine (§5.3): dedup, generation token, registry-owned disposal,
  per-activation layer/handler construction, `failed` as session-disabled-but-data-live.
- Implement registration validation (§5.4) and wire the shared registry contract test.
- Physically move lighting files under `src/modules/lighting/`; author `runtime.ts`.
- Refactor `EditorRenderer` to `SceneLayer[]`; refactor `Canvas.svelte` and `Toolbar.svelte` to
  drive off the registry; repoint the phase-2 panel map at module manifests.
- Turn on the boundary lint rules for real, including the codec/runtime isolation rule.
- **Tests:** activate → deactivate → activate leaves zero orphaned scene children; a mode switch
  mid-load discards the stale resolution; a rejected `loadRuntime` disables the mode and still
  round-trips the module's data through save.
- **This phase proves the seam using the module that already works** — if the contract is wrong,
  it is wrong against known-good behavior with an existing test suite, not against new flooring code.

### Phase 5 — Studio shell + routing (2–3 days)

- Extend `routerStore` beyond `'editor' | 'viewer'` to `#/{module}`, `#/{module}/viewer`, plus a
  mode-picker landing route.
- Preserve legacy URLs permanently: bare `#/` and `#/viewer` resolve to lighting.
- Module-aware share links (§7.5).
- Lazy-load runtimes via dynamic `import()`; verify with a bundle-size check that the IES parser and
  heatmap shaders are absent from the initial chunk.
- **Route-race tests** (§5.3): rapid `#/lighting` → `#/flooring` → `#/lighting` navigation, and a
  document open landing mid-activation, both ending with exactly one active module and no leaks.

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

| Risk                                                                 | Mitigation                                                                                            |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Big-bang refactor stalls mid-way                                     | Eight implementation phases plus scaffolding, each shippable; 1a/1b/2/3a stand alone.                 |
| Rewriting six drag operations regresses interaction feel             | Phase 1a is standalone, against current stores; per-op test for live preview + one entry.             |
| Preview and commit diverge as drag logic evolves                     | One `applyDrag`; ops return resolutions only; per-kind deep-equality test (§3.2.1).                   |
| Leaked THREE resources / stale handlers on mode switch               | Activation state machine, generation token, registry-owned disposal (§5.3); race tests in 5.          |
| Duplicate module/tool/panel ids silently shadow                      | Registration throws; shared registry contract test (§5.4).                                            |
| A compacted share payload fails the module's own decoder             | `compactForShare` returns `T`; share round-trip contract test per codec (§5.1).                       |
| Quarantined data reopened against materially different geometry      | Fingerprint in `CarriedState`, `geometryChangedSinceLoad` beside the blob, escalating warning (§7.2). |
| Runtime code mutates the document outside `commit`                   | `DeepReadonly` on every module-facing boundary; `ModuleContext` exposes operations, not stores.       |
| Custom light definitions lost or silently overridden on import       | Definitions move into `LightingData`; document copy wins; v2 conflict fixture (§7.3a).                |
| History grows unbounded once `MAX_HISTORY` is reimplemented          | Cap is in the `commit` contract (§3.1); test that commit 51 evicts entry 1.                           |
| `GrabModeDragOperation` (302 lines) is the hard conversion           | Convert it last in 1a, after the pattern is proven on `WallDragOperation`.                            |
| Reading committed where previewed is meant, or the reverse           | Visuals freeze mid-drag / saves capture half a gesture; named in §3.5, checked in review.             |
| Phase 1b must convert all 29 writers atomically — no partial landing | Reads untouched; inventory enumerated in §3.2; flip `roomStore` to derived last.                      |
| Undo/redo labels desync after repeated undo                          | Labels ride with snapshots in `HistoryEntry`; mixed-sequence test in phase 1b (§3.1).                 |
| In-place mutation bypasses history, or drifts the prune baseline     | `Readonly<T>` at boundaries, dev deep-freeze, fresh-default contract test per codec (§3.4.1).         |
| Existing share URLs break                                            | Envelope 1/2 readers are permanent; fixture tests land before the type change.                        |
| Undecodable module data silently lost on save                        | Quarantine held in `CarriedState`; value-identical round-trip test in phase 3.                        |
| Prune-on-save drops a slice a user meant to keep                     | Prune only on exact deep-equality with `defaultData()`; round-trip test in phase 3.                   |
| Codec bundle bloat defeats lazy loading                              | Lint rule bans `three` / `*.svelte` / `runtime.ts` imports from `codec.ts`; bundle check in 5.        |
| `Canvas.svelte` (1052 lines) is a merge-conflict magnet              | Do phases 1–4 on short-lived branches; avoid parallel feature work in that file.                      |
| Module contract is wrong                                             | Phase 4 validates it against lighting (known-good, tested) before flooring exists.                    |
| History snapshots balloon with plank data                            | Structural: derived output has no field on `Session` and is unnameable from `codec.ts`.               |
| Plank rendering perf                                                 | `InstancedMesh` + spatial hit-testing from the first commit, not retrofitted.                         |
| Product focus dilution (lighting designers vs. flooring contractors) | Mitigate with branding and entry points in phase 5, not with a code split.                            |

---

## 10. Out of scope

- Monorepo / workspace migration (revisit against the triggers in §1).
- 3D flooring visualization.
- Server-side persistence or accounts.
- Renaming the `lumen_2d` package (cosmetic; do it if and when the Studio ships publicly).
