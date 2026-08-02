# Studio Modularization Plan

**Goal:** extract a domain-agnostic floorplan editor from the lighting-specific code, so a second
domain (LVP flooring layout) can be built on top of it without forking or duplicating.

**Status:** proposed, not started.
**Created:** 2026-08-02
**Revised:** 2026-08-02 — commands as the write boundary, candidate-command previews, session
reducer, envelope/editor split. See §3 and the decision log in §11.

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

- quarantined blobs must not live on the document, or history clones them 50 times;
- derived layout output must not live on the document, for the same reason;
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
found another rule that mode needed. The draft after that removed the mode: drags stopped writing the
document and became ephemeral previews, with a `DragResolution` value and a pure `applyDrag`. That
was right about the mode and still one abstraction short — it left preview and commit as two code
paths held equal by a test. §3.2.1 closes that: the preview **is** the command that will be
dispatched. The general lesson is worth keeping in view for the rest of the plan — **when a design
accumulates runtime guards, the guards are usually reporting that a state exists which should not; and
when it accumulates equality tests, they are usually reporting that one thing has been implemented
twice**.

### 3.1 A session is one value, not five stores

```ts
// src/floorplan/types/document.ts

/** One closed (or in-progress) wall loop. */
export interface WallLoop {
  walls: WallSegment[];
  isClosed: boolean;
}

/** The shared, domain-agnostic drawing. No module may add a field here. */
export interface FloorplanGeometry {
  boundary: WallLoop;
  doors: Door[];
  obstacles: Obstacle[];
}

/** Room-level facts that are not geometry and not owned by any one module. */
export interface SpaceMetadata {
  ceilingHeight: number;
}

/** Editable, undoable, persisted. Nothing else belongs in here. */
export interface EditorDocument {
  geometry: FloorplanGeometry;
  space: SpaceMetadata;
  displayPreferences?: DisplayPreferences;
  /** Opaque; reachable only via readModule / withModule (§3.4). */
  modules: ModuleSlices;
}
```

**Why `geometry` is nested rather than spread across the document root.** The current
`RoomState` — `walls`, `doors`, `obstacles`, `isClosed`, `ceilingHeight`, `lights` — bakes "one
room, with a ceiling, lit" into the shape of the core type. Two of those assumptions are already
wrong for flooring. Nesting under `geometry.boundary` is what lets `boundary: WallLoop` become
`boundaries: WallLoop[]` for connected rooms and thresholds between spaces, without every module
that reads geometry being rewritten — modules read through selectors (§5.2), not through the
document root.

`ceilingHeight` moves to `space` rather than into the lighting slice. It is only _consumed_ by
lighting today, but a user editing "how tall is this room" does not think of it as a lighting
setting, and `space` costs one field. If a second module never wants it, demote it then; the
reverse direction (promoting it out of a module slice later) requires a schema migration.

**Naming churn is deliberately deferred.** `roomStore` keeps its name through phases 1a and 1b —
49 read sites across 20 files depend on it, and renaming while replacing the write model doubles the
blast radius for no structural gain. `roomStore` → `editorStore` is a late mechanical codemod, or
never. The type names change with the type; the store name does not.

```ts
// src/floorplan/types/session.ts

/** Persisted, never edited, never rendered. Carried from load to save. */
export interface CarriedState {
  quarantined: Readonly<Record<string, QuarantinedSlice>>;
  /** Structural hash of geometry at load time; see §7.2. */
  geometryFingerprint: string;
}

/** Session-scoped. Not persisted, not undoable. */
export interface Diagnostics {
  warnings: DocumentWarning[];
  /** Per-module runtime status — a session fact, never a document one (§7.2). */
  runtimeStatus: Readonly<Record<string, ModuleRuntimeStatus>>;
}

/** A snapshot and the name of the action that produced the change away from it. */
export interface HistoryEntry {
  document: EditorDocument;
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
 * shallow and `doc.geometry.doors.push(d)` would otherwise type-check. Mutable counterparts
 * exist only inside `reduceSession`, which is the sole constructor of these values.
 */
export interface Session {
  /** Committed. The only field history snapshots, autosave writes, and export reads. */
  readonly document: DeepReadonly<EditorDocument>;
  readonly carried: DeepReadonly<CarriedState>;

  /** Ephemeral. Never persisted, never undoable. */
  readonly selection: Readonly<Selection>;
  readonly interaction: DeepReadonly<Interaction>; // §3.2.1
  readonly diagnostics: DeepReadonly<Diagnostics>;

  readonly history: History;
}
```

The data lifetimes — _committed_, _carried_, _ephemeral_, _derived_ — become positions in a type
instead of conventions. Derived data gets no field at all: it lives in memoized projections computed
from narrow inputs (§7.4) and has nowhere to be written to. The committed/ephemeral line is the one
§3.2.1 turns out to depend on entirely.

`history` snapshots `EditorDocument` only. Quarantine, diagnostics, and selection are siblings of the
document, so their exclusion from undo is structural — not a `readonly` marker that TypeScript
erases at compile time while `structuredClone` copies the field anyway.

**Labels are per-entry, not per-stack.** A pair of `undoLabel` / `redoLabel` fields alongside the
stacks can name the _next_ undo but cannot survive repeated undo/redo: after committing "Move wall"
then "Change ceiling height", undoing twice has to surface "Change ceiling height" and then "Move
wall" as redo labels in that order, and that information is not recoverable from two arrays of bare
documents. Pairing each snapshot with its label makes the transfer trivial:

```ts
const MAX_HISTORY = 50; // preserved from historyStore.ts:10

// inside reduceSession, on 'command.dispatch':
const next = applyCommand(current, command);
if (deepEqual(next, current)) return session; // no-op commands push nothing
past.push({ document: current, label: labelOf(command) });
if (past.length > MAX_HISTORY) past.shift(); // evict oldest
current = next;
future = [];
undo: const e = past.pop();
future.unshift({ document: current, label: e.label });
current = e.document;
redo: const e = future.shift();
past.push({ document: current, label: e.label });
current = e.document;
```

The label rides with the entry across both stacks, so `undoLabel` / `redoLabel` are one-line derived
reads. Test with a mixed sequence: dispatch A, dispatch B, undo, undo, redo — asserting the label
pair at every step.

**The 50-entry cap is load-bearing and must not be lost in the rewrite.** `historyStore.ts:10` caps
`past` today; an unbounded stack retains whole document snapshots for the life of a session, which is
exactly the growth the module slices make worse.

Eviction is oldest-first from `past` only, and `undo`/`redo` never evict — they move entries between
the stacks, so **`past.length + future.length ≤ MAX_HISTORY`** is the real invariant. (Not "`future`
is bounded by `past`", which an earlier draft said and which is false: undo everything and `future`
is 50 while `past` is 0.) Tests: dispatch 51 times → `past.length === 50` with entry 1 gone; then
undo 50 times → `past` 0, `future` 50, sum still 50.

### 3.2 Every edit is a command

An earlier draft made the write surface `commit(label, fn)` — one call, one snapshot, one history
entry. That removes the inference, which was the point, but it leaves the _edit itself_ as an opaque
callback. An arbitrary transform cannot be named, logged, serialized, replayed, or tested without
standing up a store, and nothing stops the label from drifting away from what the function actually
does.

Make the edit a value.

```ts
// src/floorplan/types/command.ts

export type CoreCommand =
  | { type: 'wall.move'; wallId: string; start: Vector2; end: Vector2 }
  | { type: 'wall.setLength'; wallId: string; length: number }
  | { type: 'vertex.move'; index: number; position: Vector2 }
  | { type: 'vertex.insert'; wallId: string; position: Vector2 }
  | { type: 'vertex.delete'; index: number }
  | { type: 'door.add'; door: Door }
  | { type: 'door.move'; doorId: string; wallId: string; offset: number }
  | { type: 'door.remove'; doorId: string }
  | { type: 'obstacle.add'; obstacle: Obstacle }
  | { type: 'obstacle.move'; obstacleId: string; origin: Vector2 }
  | { type: 'obstacle.vertex.move'; obstacleId: string; index: number; position: Vector2 }
  | { type: 'obstacle.remove'; obstacleId: string }
  | { type: 'room.close'; vertices: readonly Vector2[] }
  | { type: 'space.setCeilingHeight'; height: number };

/** Modules contribute their own; the core never names them. Constructed via defineCommand. */
export interface ModuleCommandEnvelope {
  type: string; // `${moduleId}.${verb}`
  moduleId: string;
  payload: unknown;
}

export type EditorCommand = CoreCommand | ModuleCommandEnvelope;

export interface CommandHandler<C> {
  label(command: C): string;
  apply(doc: DeepReadonly<EditorDocument>, command: C): EditorDocument;
}

/** Pure. Looks up the handler by `type` and applies it. The only document transform in the app. */
export function applyCommand(
  doc: DeepReadonly<EditorDocument>,
  command: EditorCommand
): EditorDocument;
```

Module commands use the same identity trick as selections (§3.4), so the module id and verb are
written once and producer and consumer cannot drift:

```ts
export interface CommandKind<P> {
  readonly type: string; // `${moduleId}.${verb}`
  make(payload: P): EditorCommand;
  match(c: EditorCommand): P | null;
}

export function defineCommand<T, P>(
  codec: ModuleCodec<T>,
  verb: string,
  handler: {
    label(payload: P): string;
    apply(doc: DeepReadonly<EditorDocument>, payload: P, prev: Readonly<T>): T;
  }
): CommandKind<P>;

// modules/lighting/commands.ts
export const moveFixtures = defineCommand<
  LightingData,
  { ids: string[]; positions: [string, Vector2][] }
>(lightingCodec, 'fixture.move', {
  label: (p) => (p.ids.length > 1 ? `Move ${p.ids.length} fixtures` : 'Move fixture'),
  apply: (doc, p, prev) => ({ ...prev, fixtures: reposition(prev.fixtures, p.positions) }),
});
```

`defineCommand` returns a `T` and the registry wraps it in `withModule` (§3.4), so the common case —
a command that touches one module's slice — never sees the whole document. A handler that genuinely
needs to touch geometry _and_ a slice in one action registers against the document form instead; it
is still one command, so still one history entry. That is the case the previous `commit` /
`commitModule` pair could not express without emitting twice.

**Three rules make the command layer worth having.** Each is enforced, not documented:

1. **Commands are serializable data.** No closures, class instances, `Map`, `Set`, `THREE` objects,
   or DOM nodes in a payload. This is what makes logging, replay, fixture-based testing, and any
   future collaboration possible; without it `EditorCommand` is just a tagged callback. Enforced by a
   dev-mode assertion that every dispatched command survives a `JSON.parse(JSON.stringify(c))`
   round-trip value-identically, plus a contract test over the registry.
2. **Payloads are absolute, never deltas.** `{ ids, delta }` applied twice moves twice. Absolute
   payloads are idempotent, which is what makes the preview and the dispatch in §3.2.1 the same
   value rather than two computations that agree. Drag operations already capture their origin state
   precisely so they can compute absolute results (`WallDragOperation:41-88`). Deltas become
   interesting only if operational-transform collaboration arrives, and that is a schema change made
   once, not per command.
3. **Handlers are pure.** `(doc, command) => doc'`, no store access, no `get()`, no side effects.
   This is what lets the whole edit surface be tested as a table of `(document, command) → document`
   with no store, no DOM, and no renderer.

**What commands buy over `commit(label, fn)`:**

| Property                             | With `commit(label, fn)`                   | With `dispatch(command)`              |
| ------------------------------------ | ------------------------------------------ | ------------------------------------- |
| One action → one history entry       | By call discipline                         | By construction                       |
| Label matches the operation          | Two arguments that can drift               | `handler.label(command)` — one source |
| Edit is testable without a store     | No — the closure captures its call site    | Yes — pure `(doc, command)` table     |
| Edit is inspectable / loggable       | No                                         | Yes — it is data                      |
| Drag preview and drag commit agree   | Two code paths, held equal by a test       | The same value (§3.2.1)               |
| Geometry + module slice in one entry | Needs `commit` and `commitModule` to merge | One handler, one command              |
| Keyboard, panel, and drag share code | Three call sites building three closures   | Three producers of the same command   |

That last row is not incidental. Nudging a fixture with the arrow keys, typing a coordinate into the
property panel, and dragging it are three inputs to one operation. Today they are three code paths.

**The store surface.** `dispatch` is what application and module code sees; `commit` survives only as
an internal step of the reducer (§3.2.2).

```ts
// src/floorplan/stores/sessionStore.ts
export const sessionStore = {
  subscribe,

  /** The only way the document changes. One call → one command → at most one history entry. */
  dispatch(command: EditorCommand): void,

  /** The only way a document enters the app. */
  open(loaded: LoadedDocument): void,

  /** Ephemeral (§3.2.1). Not undoable, not persisted, records no history. */
  setInteraction(next: Interaction): void,
  select(next: Selection): void,

  /** Dispatches the previewed command and returns to `idle` — in a single emission. §3.2.1. */
  finishInteraction(): boolean,
  cancelInteraction(): void,

  /** Both reset `interaction` to `idle` atomically with the document swap. §3.2.1. */
  undo(): boolean,
  redo(): boolean,
};

/**
 * What the editor renders and what most code reads: the committed document with the
 * in-flight command previewed on top. Pure, derived, never persisted. §3.2.1.
 */
export const roomStore = derived(sessionStore, (s) => previewDocument(s.document, s.interaction));

/** What history, autosave, export, and share read. Never includes a preview. */
export const committedDocument = derived(sessionStore, (s) => s.document);
```

Every one of those methods is a thin wrapper that builds exactly one `SessionAction` and hands it to
the reducer (§3.2.2). There is no second write mode, no suppression flag, no scope to open or close,
and therefore no state in which a write is legal-or-not depending on hidden mode.

`open` constructs a whole new `Session` whose `history` is `{ past: [], future: [] }`. There is no
code path by which opening a document could push an undo entry, because opening is not a dispatch.
`carried` is replaced along with the document, so a previous document's quarantine cannot outlive it.
`selection` and `interaction` are reset in the same value, so neither stale ids nor a stale drag can
survive a swap.

`statesAreEqual` and its `JSON.stringify` of the entire document on every emission are deleted, not
optimized — history is now told what happened. (This resolves what earlier drafts filed as a
follow-up performance item; it comes free.)

**Commands are the write boundary, not the history representation.** History stays snapshot-based
with the 50-entry cap. A command log is the obvious-looking optimization and it is a trap: undo then
requires either an inverse for every command or replay-from-origin on every keystroke, and inverses
are exactly the kind of second implementation §3.2.1 exists to avoid. Revisit only alongside
collaboration, where the command log is needed for a different reason.

**Subscription granularity.** One `Session` value means every pointer move during a drag
reconstructs it and notifies every `sessionStore` subscriber. Nothing may subscribe to `sessionStore`
directly except the narrow derived stores in this file — `roomStore`, `committedDocument`,
`selection`, `history`, `diagnostics`. Svelte's `derived` propagates on every parent emission, so
those stores each guard with a reference-equality check and only emit when their own slice actually
changed; a drag then wakes the renderer and the geometry panels, not the toolbar and the share
dialog. Components subscribe to the narrow stores, never to the session. Modules subscribe to
neither — they get a `ModuleView` (§5.2). Worth a lint rule if it starts drifting.

**Every writer converts in one phase.** Making `roomStore` derived is not a gradual change: the
moment it loses `set`/`update`, every existing writer stops compiling. That is the desired property —
the compiler produces the migration checklist. Full inventory of the 29 sites:

| Where                                                                                                                                                                    | Count | Becomes                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `roomStore.ts` **drag-reachable** helpers — `updateVertexPosition`, `moveWall`, `updateDoor`, `updateObstacleVertexPosition`, `moveObstacle`                             | 5     | Command handlers (`vertex.move`, `wall.move`, `door.move`, `obstacle.vertex.move`, `obstacle.move`) — the per-frame caller disappears |
| `roomStore.ts` remaining helpers — `updateWallLength`, `insertVertexOnWall`, `deleteVertex`, `addDoor`, `removeDoor`, `addObstacle`, `updateObstacle`, `removeObstacle`  | 8     | Command handlers — bodies are already `(state) => newState`                                                                           |
| `roomStore.resetRoom`                                                                                                                                                    | 1     | `open(emptyDocument())`                                                                                                               |
| `historyStore.undo` / `.redo`                                                                                                                                            | 2     | deleted with `historyStore`                                                                                                           |
| Load paths — `App.svelte:124`, `ViewerPage.svelte:27,55`, `Toolbar.svelte:158`                                                                                           | 4     | `open(loaded)`                                                                                                                        |
| `Canvas.svelte:616` — `onUpdateLightPositions` drag callback                                                                                                             | 1     | deleted; becomes the `lighting.fixture.move` command, previewed and dispatched once (§3.2.1)                                          |
| Ordinary edits — `settingsStore:22,28`, `PropertyPanel:32`, `LightPropertiesPanel:32,54`, `Canvas.svelte:574` (delete lights), `:667` (close room), `:709` (place light) | 8     | `dispatch(...)`                                                                                                                       |

The 13 `roomStore.ts` helper bodies are already pure `(state) => newState` transforms; converting
them is moving the body into a `CommandHandler.apply` and naming its arguments. The four load paths
are the only ones that change semantics, which is the point: they are exactly the sites that push a
spurious undo entry today. The real work is the six drag operations (§3.2.1 costs).

Read sites — the large majority, including every Svelte template and every `get(roomStore)` — are
untouched, because `roomStore` survives as a derived view with its current live-during-drag meaning.

### 3.2.1 In-flight interactions are candidate commands

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

The value it computes is a `wall.move` command. So say that.

```ts
// src/floorplan/types/interaction.ts

export type DragTarget =
  | { kind: 'vertex'; index: number }
  | { kind: 'wall'; id: string }
  | { kind: 'door'; id: string }
  | { kind: 'obstacle'; id: string }
  | { kind: 'obstacleVertex'; obstacleId: string; index: number }
  | { kind: 'moduleEntity'; moduleId: string; ids: readonly string[] };

/** What the operation captured at pointer-down. Op-local; never read by the reducer. */
export interface DragOrigin {
  target: DragTarget;
  pointer: Vector2;
  captured: unknown;
}

export type Interaction =
  | { kind: 'idle' }
  /** A command the user is aiming. Dispatched verbatim on pointer-up, discarded on cancel. */
  | { kind: 'commandPreview'; command: EditorCommand; origin: DragOrigin }
  | { kind: 'drawing'; vertices: readonly Vector2[]; cursor: Vector2 | null }
  | { kind: 'measuring'; from: Vector2; to: Vector2 | null };

/** Pure. The previewed document is the committed document with the candidate command applied. */
export function previewDocument(doc: DeepReadonly<EditorDocument>, i: Interaction): EditorDocument {
  return i.kind === 'commandPreview' ? applyCommand(doc, i.command) : (doc as EditorDocument);
}
```

`drawing` and `measuring` stay separate variants rather than becoming partial commands. Drawing has
no command until the polygon closes (`room.close` is the whole edit), and measuring never produces
one at all. Forcing them into `commandPreview` would mean inventing commands that are never
dispatched.

**Operations resolve pointer input into a command.** Their `update()` signature becomes
`(ctx: DragUpdateContext) => EditorCommand`. Axis lock, snapping, guides, and constraints — the
geometry work `WallDragOperation:63-88` already does well — stay in the operation. Putting the result
into a document is `applyCommand`'s job, and it is the same `applyCommand` the dispatch will use.

Pointer-up dispatches `interaction.command` — the identical value, not a recomputation:

```ts
// startDrag / updateDrag — ephemeral only, one emission each
setInteraction({ kind: 'commandPreview', command: op.update(ctx), origin });

// pointer-up — ONE session transition: dispatch the previewed command, push history, go idle
finishInteraction();

// cancel — the document was never touched
cancelInteraction();
```

This is the whole point of the change:

> **The last frame the user saw is, by construction, the state that gets committed.**

The previous draft asserted that property with a per-drag-kind contract test comparing
`previewDocument(committed, dragging)` against the pointer-up result. That test is now deleted rather
than passing — there is one geometry implementation, applied to one value, in both places. What
remains worth testing per drag kind is that the operation resolves the _right_ command (snap, axis
lock, and constraints land where expected), which is a pure `(pointer sequence) → command` table with
no document in it at all.

#### Completing an interaction is one atomic transition

`finishInteraction()` is a distinct reducer action, not `dispatch(...)` followed by
`setInteraction(...)`. Two emissions would leave an observable intermediate state in which the
document already contains the command's result while `interaction` still describes it — so
`roomStore` would derive the command over a document that already has it applied. Absolute payloads
make that frame harmless rather than wrong, but it is still a redundant emission and an incoherent
`Session`, which is exactly what §3.1 exists to prevent.

The same rule applies to every transition that changes the committed document:

| Operation             | Interaction afterwards                                            |
| --------------------- | ----------------------------------------------------------------- |
| `finishInteraction()` | `idle`, in the same emission as the dispatch and the history push |
| `undo()` / `redo()`   | `idle`, set **atomically with** the document swap — see below     |
| `open(loaded)`        | `idle`, with selection cleared, in the one `Session` replacement  |
| `dispatch(command)`   | Unchanged — an ordinary command is not part of an interaction     |

**Undo and redo must clear the interaction, not merely coexist with it.** An earlier draft said undo
during a drag "is well-defined because there is no in-flight document write to conflict with". That
was wrong in a different way: if the interaction survives, the candidate command is immediately
re-applied to the _restored_ document, using ids or vertex indices that were resolved against the
pre-undo document. Undoing the deletion of the very wall being dragged, or undoing a vertex
insertion that shifts indices, then previews a command against entities that no longer mean the same
thing. Clearing to `idle` in the same transition removes the question.

Tests: drag an entity and undo mid-drag; undo to a snapshot that does not contain the dragged
entity; redo the same; assert in each case that the interaction is `idle` and the rendered document
equals the restored snapshot exactly.

#### What this deletes

This is not a smaller version of the gesture design, nor of the `DragResolution` design. It removes
both concepts:

| Removed                                                                         | Because                                                                 |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `Gesture`, `begin`, `apply`, `applyModule`, `transact`, and their rules table   | Nothing writes the document mid-interaction, so nothing needs a scope   |
| "`commit` throws while a gesture is open", and the other five runtime guards    | There is no mode in which a write is illegal                            |
| `transact` sync-only / async-rejection / nesting rules                          | No callback scope exists                                                |
| Gesture-leak hazard; `pointercancel` / `blur` as a _history_ risk               | A missed exit leaves a stale preview, not a silently suppressed history |
| `pauseRecording` / `resumeRecording` / `isRecordingPaused` / `stateBeforePause` | No successor concept at all                                             |
| `DragResolution` and `applyDrag`                                                | The resolution _is_ the command; `applyCommand` is the only transform   |
| The preview-equals-commit contract test, per drag kind                          | One implementation, one value — nothing left to disagree                |
| `IDragOperation.cancel()` in all six operations                                 | Cancel discards the candidate; the document was never modified          |
| The pure-transform-plus-two-runners split for six dual-use edits                | A drag and a panel edit produce the same command                        |
| `commit(label, fn)` / `commitModule(codec, label, fn)` as a public API          | One `dispatch`; module edits are module-owned commands (§3.2)           |
| No-op detection as a gesture-close concept                                      | Falls out of the reducer skipping a command whose result is value-equal |

The runtime guards that survive are the ones that are genuinely runtime: decoding stored blobs
(§5.1), the quarantine/live id collision assert (§7.1), refusing to share an undecodable module
(§7.1), dev deep-freeze and command serializability (§3.4.1, §3.2), and the fresh-defaults contract
test. Those are parsing and JS mutability, not mode.

#### What it costs, honestly

- **Six drag operations change shape**: `update()` returns a command instead of calling a writing
  callback, and `cancel()` is deleted. `WallDragOperation` is the easy case (delete `:90`,
  `:100-108`, return the value); `GrabModeDragOperation` (302 lines) is the one to scope carefully —
  it drags a heterogeneous selection, so it produces either a compound command or one command with a
  multi-entity payload. Decide that when converting it, not before. ~1000 LOC of operations touched,
  mechanically.
- **`DragManagerCallbacks` collapses.** The seven `on*` writing callbacks become one return type. This
  is a simplification, but it is a wide edit across `Canvas.svelte`'s `onMount` wiring.
- **A command registry is new surface.** ~25 handlers, each small, plus the registry and its
  serializability assertion. This is real added code; it pays for itself the first time an operation
  needs to be driven from the keyboard as well as the pointer, and every time an edit needs testing.
- **Derived stores must read `roomStore` (previewed), not `committedDocument`.** Dead zones, spacing
  warnings, and lighting stats update live during a drag today; pointing them at the committed
  document would freeze them mid-gesture. Persistence, history, export, and share read
  `committedDocument`. Getting this backwards in either direction is the one new mistake this design
  makes available — call it out in review.
- **`applyCommand` runs per frame.** It rebuilds the touched wall and the walls array — the same
  work `roomStore.update` did per frame today, so no regression, but it must stay allocation-light.
  Handlers are on the pointer-move path; no handler may allocate proportional to the whole document.

#### Interaction state is a tagged union, which removes its own invalid states

`WallDragOperation` currently encodes a two-state machine in five nullable fields — `_isActive`,
`wallId`, `originalStart`, `originalEnd`, `startPosition` — and opens `update()` with a six-clause
guard checking them (`:53-61`). Most of the 32 representable combinations are meaningless. As an
`Interaction` variant, the drag's data exists only in the `commandPreview` case, the guard
disappears, and "active but missing its origin" stops being expressible.

Tests: a drag that returns to its origin dispatches a command that is a no-op and pushes no entry;
cancel leaves the committed document byte-identical; every drag op previews live and pushes exactly
one labeled entry; the mixed-label undo/redo sequence from §3.1.

### 3.2.2 The session is a reducer

`dispatch` then `setInteraction` is two emissions and an intermediate state. So is `open` then
`select`. The fix is not discipline at each call site — it is to make every transition one action
against one pure function.

```ts
// src/floorplan/stores/reduceSession.ts

export type SessionAction =
  | { type: 'document.open'; loaded: LoadedDocument }
  | { type: 'command.dispatch'; command: EditorCommand }
  | { type: 'interaction.set'; interaction: Interaction }
  | { type: 'interaction.commit' }
  | { type: 'interaction.cancel' }
  | { type: 'selection.set'; selection: Selection }
  | { type: 'history.undo' }
  | { type: 'history.redo' }
  | { type: 'diagnostics.setRuntimeStatus'; moduleId: string; status: ModuleRuntimeStatus };

/** Pure, total, exhaustively switched. The whole state machine. */
export function reduceSession(session: Session, action: SessionAction): Session;
```

`sessionStore` is then `writable<Session>` plus a `send(action)` that assigns
`reduceSession(current, action)` and emits **exactly once**. The public methods in §3.2 are
one-liners over `send`. Consequences that were previously rules become cases in a switch:

- `interaction.commit` applies the previewed command, pushes one history entry, and sets
  `interaction: { kind: 'idle' }` — in one returned value.
- `history.undo` / `history.redo` swap the document and clear the interaction together.
- `document.open` replaces document, carried, diagnostics, history, selection, and interaction at
  once, because it returns a new `Session` rather than mutating six fields.
- A command whose result is value-equal to the current document returns the session unchanged, so
  no-op detection is one line and applies everywhere.

The testing consequence is the reason to do it. The entire state machine is
`(Session, SessionAction) => Session`: no store, no Svelte, no DOM, no `THREE`. Combined with pure
command handlers, the only things left that need a running app are rendering and input.

### 3.3 Normalize on load, prune on save

An absent module slice creates three states where two suffice: absent, default-but-unwritten, and
materialized. That trichotomy is what forces read-time defaults, the "activation must never write"
rule, and a special helper that must materialize and edit in a single emission.

Collapse it:

- **On load**, `decodeDocument` materializes `codec.defaultData()` for every registered, enabled
  module. After decode, `document.modules[id]` is always present for every live module.
- **On save**, `encodeDocument` omits any slice that deep-equals its codec's default.

Now reads are ordinary field reads, writes are ordinary commands, and visiting a mode for the first
time produces a document that serializes identically to the one that was loaded. Autosave dirty
checks compare normalized documents to normalized documents, so an empty mode visit is not an edit.
§7.2's absent-slice row and the whole read-time-default mechanism disappear.

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
  compactForShare?(data: Readonly<T>): T;
}

/** `ModuleSlices` is opaque — no index signature is exported, so these are the only doors. */
export function readModule<T>(
  doc: DeepReadonly<EditorDocument>,
  codec: ModuleCodec<T>
): Readonly<T>;

/** Pure: returns a new document with this module's slice replaced. No store access. */
export function withModule<T>(
  doc: DeepReadonly<EditorDocument>,
  codec: ModuleCodec<T>,
  fn: (prev: Readonly<T>) => T
): EditorDocument;
```

Call sites read `readModule(doc, lightingCodec)` and get `LightingData`, not `unknown`. The id string
is written once, in the codec.

`withModule` is the plumbing `defineCommand` (§3.2) is built on, and is exported so a handler that
must touch geometry and a slice in one command can compose them. It is pure and takes no store, so
it cannot be a second write path — the only way its result reaches the session is by being returned
from a command handler.

**Module data gets dragged too, and needs no special case.** Lighting's `onUpdateLightPositions`
rewrites every selected fixture's position on each pointer move (`Canvas.svelte:615-623`), and once
`fixtures` lives in `modules.lighting` that is a slice write. Flooring will want the same for a
draggable layout origin and for transitions. Under §3.2.1 these are ordinary previews: the drag
resolves to a `lighting.fixture.move` command, `previewDocument` applies it like any other, and
pointer-up dispatches that same value.

This also keeps "`modules[id]` holds input, never output" true. `T` is named by `codec.ts`, and the
boundary lint rule (§4) forbids `codec.ts` from importing `runtime.ts`, so the plank-layout _output_
type is not conveniently reachable from anywhere that can write a slice.

**That lint rule is a guardrail, not a proof, and the plan should not claim otherwise.** A developer
can restate a structural type by hand, or route output through `unknown`. The enforcement that
actually holds is behavioral, and it is what the tests check:

- codecs own validated input and configuration only;
- runtime outputs have no persistence API to reach — nothing accepts them;
- every module write goes through a registered command;
- the codec round-trip test asserts the persisted shape, so an output field that sneaks into a slice
  shows up as a round-trip or schema failure rather than as a silent 40× history blowup.

Lint keeps the seam from rotting; the tests are what make the guarantee.

**Selections** — same trick as commands, and it retires the hand-written validating guard:

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

### 3.4.1 Documents, commands, and defaults are immutable

The command model assumes handlers do not mutate what they are handed. Left implicit, it breaks in
three ways, and the second is nasty:

1. A handler mutates its `doc` argument in place and returns it. `deepEqual(next, current)` is then
   trivially true, the reducer treats the command as a no-op, and the edit lands in the document with
   no history entry. Undo silently skips it.
2. `defaultData()` returns a shared object — a module-level `const`, or an object literal captured
   by a closure. Normalization (§3.3) stores that same reference into the document, a caller mutates
   it, and now the baseline that prune-on-save deep-compares against has drifted to match the
   document. The slice is pruned on save and the user's data is silently dropped. This one survives
   review easily and shows up as data loss much later.
3. A command payload holds a live reference — a `Vector2` the operation keeps mutating, a `THREE`
   object — so the previewed command changes under the reducer between emissions and the dispatched
   value is not the one that was previewed.

Four defenses, none expensive:

- **`DeepReadonly` at every exported boundary** — `Session`, `readModule`, `ModuleView`,
  `CommandHandler.apply`, `SceneLayer.update`, `ToolDescriptor.enabled` (§3.1, §5.2). This is the
  primary defense, not a first line: bare `Readonly<T>` is shallow and would let
  `doc.geometry.doors.push(d)` type-check. Mutable counterparts exist only inside `reduceSession`,
  which is the sole constructor of these values.
- **Deep-freeze in development, as a backstop for the gaps `DeepReadonly` cannot close** — data
  arriving from `JSON.parse`, `structuredClone` results, and any `as` cast. `open`, every dispatched
  command's result, and every `defaultData()` result pass through a recursive `Object.freeze` under
  `import.meta.env.DEV`. For that to actually vanish from production the call must sit behind a
  statically eliminable branch — a bare `if (import.meta.env.DEV)` that Vite replaces with `false`
  and the minifier drops — and the freeze helper must have no retained side effects (no registry of
  frozen objects, no logging). A `DEV &&`-guarded expression assigned to nothing, or a helper that
  memoizes what it froze, defeats elimination and ships the cost.
- **Command serializability assertion (§3.2).** Under `import.meta.env.DEV`, every dispatched command
  must survive `JSON.parse(JSON.stringify(c))` value-identically. This closes failure (3) and is the
  check that keeps the replay/logging/collaboration properties real rather than aspirational.
- **Fresh-default test, applied to every codec.** A shared contract test — run against each
  registered codec, not written per module — asserting `defaultData() !== defaultData()` and that
  mutating one result leaves a second call unaffected. This is the test that closes failure (2), and
  it must be part of the codec registration suite so a new module gets it for free.

### 3.5 What this buys, itemized

| Rule that had to be remembered                     | Now                                                                         |
| -------------------------------------------------- | --------------------------------------------------------------------------- |
| Quarantine must not be inside the document         | It is a sibling field of `Session`; history snapshots `EditorDocument` only |
| Derived output must not be stored                  | No field for it; projections derive from narrow inputs (§7.4)               |
| Absent slices resolve at read time, never write    | Slices are normalized on load, pruned on save                               |
| Module edits must emit exactly once                | A module edit is a command; one command, one entry                          |
| Labels must be kept in sync with what changed      | `handler.label(command)` — the label is derived from the operation          |
| Loads must pause, then `clear()`, never `resume()` | `open()` builds a fresh `Session`; opening is not a dispatch                |
| Loads must reset five stores together              | One value, one reducer action                                               |
| Selection must be cleared on document swap         | It is part of the value being replaced                                      |
| `resetRoom()` must be folded into the load path    | `resetRoom` becomes `open(emptyDocument())`                                 |
| Multi-step drags must pause/resume history         | Drags never write the document; they aim a command (§3.2.1)                 |
| Drag cancel must correctly undo its own writes     | Cancel discards a candidate; there was nothing to undo                      |
| Preview and commit must be kept in agreement       | They are the same command value applied by the same function                |
| Every transition must emit exactly once            | One reducer action per transition, by construction (§3.2.2)                 |
| Interaction state must be internally consistent    | `Interaction` is a tagged union; per-variant fields only                    |

Costs, stated honestly:

- One large mechanical pass over **all 29 write sites** (§3.2), which cannot be split across phases —
  the moment `roomStore` becomes derived, every writer breaks at once. Under §3.2.1 these are all the
  same conversion, so it is bulk, not difficulty.
- **A command registry is genuinely new code** — ~25 handlers plus the registry, the label functions,
  and the serializability assertion. The 13 `roomStore.ts` helper bodies move into handlers rather
  than being rewritten, so most of it is relocation, but the registry itself is net-new surface.
- **The six drag operations change shape** — `update()` returns a command instead of calling a writing
  callback, `cancel()` is deleted, and `DragManagerCallbacks`' seven writing callbacks collapse into
  a return type. This is the real work of phase 1a and the only part that is not mechanical.
- `applyCommand` runs per frame — the same work the per-frame `roomStore.update` did today, so no
  regression, but handlers must stay allocation-light.
- One deep-equal comparison per dispatch, and one per module slice on save (cheap — slices are small
  by construction, since output is never stored).
- `Session` is a wide object that every action reconstructs; structural sharing makes this a handful
  of allocations per dispatch.
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
    commands/         # command registry + core handlers (one file per noun)
    stores/           # sessionStore + reduceSession (+ roomStore/selection/history derived views),
                      #   settingsStore, themeStore
    persistence/      # documentCodec, envelope types, localStorage, json, shareUrl
    types/            # geometry, document, session, command, module, interaction, selection
    ui/               # FloatingPanel, LengthInput, StatusBar, PropertyPanel primitives
  modules/
    codecs.ts         # eager barrel: every module's codec, statically imported
    lighting/
      codec.ts        # EAGER — schema, defaults, decode, compactForShare. No THREE, no Svelte.
      commands.ts     # EAGER — defineCommand handlers over LightingData
      runtime.ts      # LAZY  — tools, layers, handlers, panels, stats
      ...             # types, stores, renderers, components
    flooring/         # (new) same shape
  app/                # Studio shell: mode picker, routing, toolbar composition, module registry
  main.ts
```

`commands.ts` sits with the codec on the eager side. Commands are pure data transforms over slice
types; a module's edits must be dispatchable before its runtime has loaded (an undo arriving during
a mode switch, a share link opening straight into a document), so the handler registry cannot be
lazy. Like the codec, it may not import `three` or Svelte.

Boundaries are **directories plus lint rules**, not packages. Enforced via
`eslint-plugin-import` (or `eslint-plugin-boundaries`) in `eslint.config.js`:

- `src/floorplan/**` may not import from `src/modules/**` or `src/app/**`.
- `src/modules/a/**` may not import from `src/modules/b/**`.
- `src/modules/*/codec.ts` and `src/modules/*/commands.ts` may not import from their own
  `runtime.ts`, from `three`, or from `*.svelte`.
- `src/app/**` may import from anywhere.

Worth adding on day one — the repo already runs `knip` and `jscpd`, so there is an existing appetite
for mechanical enforcement, and a lint rule is what actually keeps the seam from rotting. The
codec/runtime rule keeps the eager bundle small: without it, one stray import silently pulls the IES
parser into every bundle. Per §3.4 it also discourages storing derived output — but the guarantee
there comes from the round-trip tests, not from the lint rule.

---

## 5. The module contract

Split in two. **This split is the resolution to the lazy-loading/synchronous-persistence conflict:**
data handling and edits are eager and synchronous, UI and rendering are lazy.

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
  /** Written by a newer build. Blob is preserved verbatim; module data is quarantined. */
  | { status: 'unsupported'; writtenVersion: number; message: string }
  /** Corrupt or fails validation. Blob is preserved verbatim; module data is quarantined. */
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
would appear as quarantined data on the recipient's machine rather than as a bug on the sender's.
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

  tools?: ToolDescriptor[];
  layers?(scene: THREE.Scene): SceneLayer[];
  handlers?(ctx: ModuleContext): IInteractionHandler[];
  /** Property panel per selection kind this module owns, keyed by `SelectionKind.panelKey`. */
  panels?: Record<string, ComponentType>;
  statsPanel?: ComponentType;
  shortcuts?: ShortcutDescriptor[];
  /** Called once per activation, after layers and handlers are constructed. */
  onActivate?(ctx: ModuleContext, scope: ActivationScope): void;
}
```

**A capability-array variant was considered and declined.** Replacing the manifest with
`capabilities: ModuleCapability[]` was proposed to avoid an ever-growing interface. It does not buy
that: adding a capability costs a union member _and_ a shell branch, which is the identical edit to
adding an optional field _and_ a shell branch. "Modules implement only what they need" is already
true of optional properties, and multiplicity is already handled (`layers()` returns an array,
`panels` is a record). The one real benefit — lifecycle attached per contribution — is better served
by the activation scope in §5.3, which owns disposal regardless of the manifest's shape. Revisit at
phase 6 if a second module shows the extension points genuinely diverging.

```ts
export interface ToolDescriptor {
  id: string; // namespaced: 'lighting.place', 'flooring.origin'
  label: string;
  icon: string;
  shortcut?: string;
  /** Gate on document state. Receives the module's own view, not the document. */
  enabled?: (view: ModuleView<unknown>) => boolean;
}

export interface SceneLayer {
  id: string;
  update(view: ModuleView<unknown>): void;
  setVisible(v: boolean): void;
  dispose(): void;
}
```

**Modules never receive the whole document.** A runtime is constructed with its codec, so what it
gets is a typed view over exactly what it is entitled to read:

```ts
export interface ModuleView<T> {
  readonly geometry: DeepReadonly<FloorplanGeometry>;
  readonly space: DeepReadonly<SpaceMetadata>;
  readonly data: Readonly<T>;
  readonly selection: Readonly<Selection>;
}

/** What a runtime is given. Capabilities, not stores. */
export interface ModuleContext<T> {
  /** The only way module data changes. Commands are module-owned (§3.2). */
  dispatch(command: EditorCommand): void;
  select(next: Selection): void;
  setInteraction(next: Interaction): void;
  /** Current view; also delivered to layers on update. */
  view(): ModuleView<T>;
}
```

This does three things at once. It stops a module from reading another module's slice by accident.
It makes dependency tracking legible — what a layer re-derives from is the shape of its view, not
"the document". And it removes the last handle by which runtime code could reach the session store
and write outside a command; `ModuleContext` hands out operations, and `dispatch` only accepts data.

If two modules' needs diverge — flooring wants boundaries, obstacles, and doors; lighting wants
ceiling metadata — the answer is explicit core selectors composed into the view, not widening the
view back into the whole document.

`SceneLayer` is deliberately close to the shape the existing renderers already have — they all expose
`update(...)`, `setVisible(...)`, `dispose()`. The change is narrowing `update` to take a view, so
`EditorRenderer` can hold a `SceneLayer[]` and loop instead of naming each renderer as a field with a
bespoke method (`updateLights`, `updateDoors`, `updateObstacles`).

One consequence to watch: `update(view)` asks every layer to re-derive on every change to anything in
its view. That is fine for lighting and is what the renderers effectively do today, but a plank
layout is expensive enough that a naive implementation would recompute on unrelated edits — including
on selection changes, which are in the view. `SceneLayer` may therefore declare a selector —
`inputs?: (view) => unknown` — with the shell skipping `update` when the selected inputs are
reference-equal to the previous call. Add it when flooring needs it (§7.4), not before; noted here so
the interface has room.

### 5.3 Activation is an owned scope with a generation token

`loadRuntime()` is asynchronous, while mode switches, route changes, and document opens are not. Left
unspecified this produces leaked `THREE` resources, orphaned subscriptions, and handlers wired to a
mode the user already left. The registry owns a per-module record:

```ts
type RuntimeState =
  | { status: 'unloaded' }
  | { status: 'loading'; token: number; promise: Promise<ModuleRuntime> }
  | { status: 'active'; runtime: ModuleRuntime; scope: ActivationScope }
  | { status: 'failed'; error: Error };
```

**The activation scope is the unit of ownership**, not an ad-hoc list of layers and handlers:

```ts
export interface ActivationScope {
  /** Register anything that must be torn down when the module deactivates. */
  own(disposer: () => void): void;
  /** Aborted when the scope is disposed; pass to async work and workers. */
  readonly signal: AbortSignal;
}
```

Everything created for an activation is registered with the scope: scene layers, input handlers,
keyboard shortcut bindings, derived-store subscriptions, projection caches (§7.4), workers, and any
in-flight asynchronous work. Disposal walks the registered disposers in reverse order and aborts the
signal. Naming only layers and handlers — as an earlier draft did — leaves subscriptions and workers
to leak, and flooring's layout engine is exactly the thing that will hold both.

Rules:

- **Dedup.** A second `activate()` while `loading` returns the in-flight promise. `import()` is
  already idempotent, but the scope construction that follows it is not.
- **Generation token.** Every activation increments a counter. When a load resolves, the registry
  compares its token against the current one; a stale resolution constructs nothing and disposes
  nothing, because it never built anything. This is what makes "switch modes twice quickly" safe.
- **Ownership.** The registry creates the scope and the registry disposes it — modules never dispose
  their own contributions. `open(loaded)` deactivates the active module before swapping documents, so
  no layer ever sees two unrelated documents.
- **Caching.** The resolved module _record_ is cached; the scope and everything in it is **not**. It
  binds to a `THREE.Scene` and a `ModuleContext` and is rebuilt per activation. Caching it is the
  straightforward way to leak a scene.
- **Failure is session-scoped and does not touch data.** A runtime that fails to load or throws
  during construction moves to `failed`, and the module's runtime status is recorded in
  `Diagnostics`. Its slice stays decoded, live, and **is written back normally on save** — a runtime
  failure is not a decode failure (§7.2).
- **Concurrency bound.** Only one module is active at a time in the current product shape (one mode
  visible). If that changes, the state machine is per-module already.

Tests, in phase 4: activate/deactivate/activate leaves zero orphaned scene children and zero live
subscriptions; a mode switch mid-load discards the stale resolution; disposing a scope aborts its
signal and any pending projection; a rejected `loadRuntime` disables the mode, surfaces the error,
and still round-trips the module's data through save.

### 5.4 Registration validates and fails fast

The design depends on a lot of unique strings. A duplicate does not fail loudly on its own — it
silently shadows, and the failure surfaces later as the wrong codec decoding a slice, the wrong
handler applying a command, or a panel rendering for the wrong selection. Registration therefore
throws on:

| Check                                              | Why                                                |
| -------------------------------------------------- | -------------------------------------------------- |
| Duplicate module id                                | Second codec would shadow the first for that slice |
| `runtime.id !== codec.id`                          | Pairs the wrong runtime to a slice                 |
| Duplicate command type                             | Silent shadow in the command registry              |
| Duplicate tool id, layer id, or panel key          | Silent overwrite in the toolbar / dispatch map     |
| Tool id or command type not namespaced with the id | Guarantees the above cannot collide across modules |
| Shortcut already bound                             | See precedence below                               |

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

Target: the `EditorDocument` / `Session` shape in §3.1. `lights` becomes
`modules.lighting.fixtures`, reachable only through `readModule(doc, lightingCodec)` and writable
only through a `lighting.*` command.

`rafterConfig` moves into the lighting slice too — a ceiling-joist concept with no meaning for
flooring. So do the custom light definitions the fixtures reference, which are a third payload with
no home in the current design and their own correctness bug (§7.3a). `ceilingHeight` moves to
`space` (§3.1) rather than into the slice, though lighting is its only consumer today.

The flat root — `walls`, `doors`, `obstacles`, `isClosed` — becomes nested `geometry` at the same
time, since both are one type change and one migration.

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

Panel dispatch key: ``s.kind === 'module' ? `${s.moduleId}.${s.type}` : s.kind`` — the same string
`SelectionKind.panelKey` exposes, so registration and dispatch cannot disagree.

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
`Canvas.svelte` asks the registry for the active module's scope and loops; `Toolbar.svelte` renders
`registry.tools()`. This is the largest mechanical chunk of the work and should be done _after_ A and
B, because both simplify it substantially — in particular, the six `current*` mirror variables
collapse to one when selection lives in `Session`.

---

## 7. Document lifecycle

### 7.1 The persisted envelope is a different type from the editor document

Today there are three entry points with three behaviors: `jsonImport.validateRoomState` validates
properly, `localStorage.loadFromLocalStorage` casts `JSON.parse(data) as RoomState` with three
ad-hoc shape-sniffing migrations and no validation, and `shareUrl.decodeShareData` delegates to
`importFromString`. Local storage is the weakest and will be the most common source of
pre-migration documents.

They converge on one module — and on an explicit boundary between what is stored and what is edited:

```ts
// src/floorplan/persistence/envelope.ts — the on-disk shape, never used by the editor

export interface DocumentEnvelopeV3 {
  version: 3;
  geometry: unknown;
  space?: unknown;
  displayPreferences?: unknown;
  modules: Record<string, ModuleBlob>;
  /** Set beside a quarantined blob when geometry changed since it was loaded (§7.2). */
  quarantineFlags?: Record<string, { geometryChangedSinceLoad: boolean }>;
}

// src/floorplan/persistence/documentCodec.ts

/** `unknown` in, validated `EditorDocument` out. Normalizes module slices (§3.3). Synchronous. */
export function decodeDocument(raw: unknown): LoadedDocument;

/** Prunes slices that deep-equal a freshly-allocated `defaultData()` (§3.3, §3.4.1). */
export function encodeDocument(
  document: DeepReadonly<EditorDocument>,
  carried: DeepReadonly<CarriedState>,
  target: EncodeTarget
): DocumentEnvelopeV3;

export type EncodeTarget =
  | { kind: 'file' }
  | { kind: 'local' }
  /** Single-module view; see §7.5. */
  | { kind: 'share'; moduleId: string };

/** What a load produces; consumed only by `sessionStore.open` (§3.2). */
export interface LoadedDocument {
  document: EditorDocument;
  carried: CarriedState;
  diagnostics: Diagnostics;
}
```

**Why two types rather than persisting `EditorDocument` directly.** They are close today and will not
stay close: the envelope carries schema versions, omitted defaults, quarantined blobs, drift flags,
and permanent legacy shapes, none of which the editor should be able to name. Keeping them separate
makes one sentence true — **the decoder is the only code that handles hostile, legacy, or partial
input; everything downstream of it receives a valid, normalized `EditorDocument`** — and gives the
`version: 1 | 2` readers somewhere to live that is not the editor's type file. `documentCodec` is the
only translator in either direction.

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

| Rule                           | Behavior                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `target: 'file'` / `'local'`   | Live slices encoded at `codec.schemaVersion`, defaults pruned; quarantined blobs merged back verbatim. |
| `target: 'share'`              | **Quarantined blobs are omitted entirely**, along with all non-target live slices.                     |
| Same id in both maps           | **Live wins.** Also a bug — assert in dev builds; `decodeDocument` puts each id in exactly one map.    |
| Target module is quarantined   | **Not shareable.** The share UI blocks it; `encodeDocument` throws if asked.                           |
| Target module's runtime failed | **Shareable.** The data is live and valid; only this session's UI is unavailable (§7.2).               |

That fourth rule matters: a quarantined blob is by definition one this build could not decode, so it
cannot be compacted, validated, or meaningfully rendered by a viewer. Emitting a share link for it
would produce a URL that fails on open. The fifth is the distinction §7.2 draws — a runtime failure
never restricts what can be done with the data.

### 7.2 Two statuses: can the data be preserved, and can this build operate on it

**Geometry is the shared asset; a broken module must never cost the user their room.** Only
geometry validation failure rejects the document.

These are two independent questions and the plan previously collapsed them into one "disabled" flag.
Separate them:

```ts
/** Document-scoped. Decided at decode; determines what is written back on save. */
export type ModuleDataStatus =
  | { kind: 'live' }
  | { kind: 'quarantined'; reason: 'unsupported' | 'invalid' | 'unknownModule'; message?: string };

/** Session-scoped. Lives in `Diagnostics`, never in the document or the envelope. */
export type ModuleRuntimeStatus =
  | { kind: 'inactive' }
  | { kind: 'loading' }
  | { kind: 'active' }
  | { kind: 'failed'; message: string };
```

The two are almost independent. Quarantined data implies no runtime can usefully activate, so the
mode is not offered. But `live` data with a `failed` runtime is a real and important state: the
module's import 404'd, WebGL lacks a needed extension, or the layout engine threw during
construction. The data decoded fine and must be written back at the current `schemaVersion` exactly
as if the mode had been visited.

| Case                                   | Data status                    | Effect                                                        |
| -------------------------------------- | ------------------------------ | ------------------------------------------------------------- |
| Geometry invalid                       | —                              | **Reject the document.** Throw `ValidationError` as today.    |
| Module slice absent                    | `live`                         | Normalized to `codec.defaultData()` during decode (§3.3).     |
| Module slice `ok`                      | `live`                         | In `document.modules[id]`; editable via commands.             |
| Module slice `unsupported` (newer `v`) | `quarantined: 'unsupported'`   | Blob verbatim in `carried`; warn "saved by a newer version".  |
| Module slice `invalid`                 | `quarantined: 'invalid'`       | Blob verbatim in `carried`; warn with the codec's message.    |
| No codec registered for the id         | `quarantined: 'unknownModule'` | Blob verbatim; no warning (expected in single-module builds). |
| Runtime failed to load (§5.3)          | unchanged (`live`)             | `runtimeStatus: failed`. Data saves normally. Mode hidden.    |

Quarantined means: the mode is not selectable, no default is materialized, no commands for it are
registered, and its blob is written back unchanged on save. Runtime-failed means: the mode is not
selectable this session, and nothing else changes. The user can still edit geometry and use the other
module in both cases.

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

`CarriedState` carries a geometry fingerprint captured at load — a cheap structural hash of the
boundary, obstacles, and doors. On save, if the fingerprint no longer matches, the envelope records
`geometryChangedSinceLoad: true` in `quarantineFlags`, **next to** the blob and never inside it. The
reading build gets an explicit signal that the data predates the current room and can decide for
itself whether to recompute, warn, or discard.

In the app, the diagnostic escalates: a quarantined module's warning gains "the room has been edited
since this data was saved" on the first geometry command. Tests: edit geometry with a quarantined
slice present, save, and assert the blob is value-identical and the flag is set; edit nothing and
assert the flag is absent.

This is a product decision as much as a data one, and it is the conservative branch — we never
silently discard a user's work, and we never let unparseable data freeze the editor.

### 7.3 Versioning — two levels, and the existing collision

`ExportData.version: 1 | 2` already exists (`jsonExport.ts:5`), but it versions the _light-definition
envelope_, not the document schema. Overloading it for the modular shape would give one number two
meanings and make the migration matrix ambiguous.

Resolution — two independent, explicitly-named levels:

- **Envelope**: `version: 3` means modules-shaped, with nested `geometry`. Readers for `1` and `2`
  are kept **permanently**; they parse the legacy flat shape, nest it under `geometry`, lift
  `ceilingHeight` into `space`, and lift `lights`, `rafterConfig`, **and `lightDefinitions`** into
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

### 7.4 Derived data is a projection over narrow inputs

With §3.2 in place, history no longer diffs — the reducer pushes the pre-dispatch document and the
command's label. Two rules remain, and both are now enforced structurally rather than by discipline:

**(a) Derived data must not enter the document.** Planks are a pure function of
(boundary, obstacles, `LayoutConfig`). Storing generated planks would put thousands of objects into
every one of 50 history snapshots. **Store the config; derive the layout.** The computed layout is
never persisted, never cloned, never diffed. This also gives correct undo granularity for free —
undo steps back through user intent ("changed stagger to 1/3"), not through machine output.

Enforcement: `Session` has no field for derived data; no API accepts a layout for storage; the
round-trip test asserts the persisted slice shape (§3.4 — the lint rule helps, but the test is the
guarantee).

**A Svelte `derived` store is not sufficient for the flooring case, and the plan should say so now.**
A plank layout over a nontrivial polygon is expensive enough that recomputing it synchronously inside
a store subscription would run on every pointer move of a wall drag and block the frame. The
requirements, to be met by the flooring runtime in phase 6:

- **Narrow inputs.** Derive from `(boundary, obstacles, layoutConfig)`, not from `Session` and not
  from the whole `ModuleView` — a selection change must not invalidate a layout.
- **Keyed cache.** Memoize on a structural key over those inputs, so undo/redo across a config change
  is a cache hit.
- **Cancellable.** Take the activation scope's `AbortSignal` (§5.3); a superseded computation stops.
- **Last-good-wins.** Keep serving the previously completed layout while a new one computes, so
  dragging a wall degrades to a stale floor rather than an empty one.
- **Relocatable.** Nothing about the document architecture may assume the computation is
  synchronous, so moving it to a worker later is a change inside the flooring module.

The interface that expresses this — some `Projection<I, O>` with a key function and an async
`compute` — is deliberately **not** specified here. There is no consumer yet, and specifying a
generic projection framework before flooring exists is the same mistake §1 declined to make with the
monorepo. §5.2's `inputs?: (view) => unknown` selector is the seam; the real shape gets designed
against the real engine in phase 6, and the requirements above are the acceptance criteria.

**(b) Undo stays global across the whole document, not per-module.** A single command can touch both
geometry and a module slice (§3.2), so per-module stacks would either desync or need cross-stack
coordination. Mitigation for the "undo did something I can't see" problem: every command carries a
label derived from its handler, `History` exposes `undoLabel` / `redoLabel`, and the UI names what
will be undone. Revisit only if cross-mode undo confusion shows up in real use.

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

The split points are deliberate: **1a is the edit model, 1b is state, 3a/3b are the data plane
(infrastructure then live conversion), 4 is the UI plane.** Each of 1a, 1b, 2, and 3a is worth
landing even if the next one never does.

### Phase 0 — scaffolding (½ day)

- Add `docs/plans/` (this file).
- Add the import-boundary lint rule with the target directory layout allow-listed, initially with
  no directories to police. Landing the rule before the moves means each subsequent phase is
  validated as it lands.

### Phase 1a — commands and candidate-command previews (5–6 days) ← **start here**

Shippable on its own against the _current_ stores, so phase 1b inherits a codebase that already has
a single, inspectable write model. Commands land here rather than in 1b because the six drag
operations are rewritten in this phase either way — converting them to produce commands is the same
edit as converting them to produce resolutions, and doing it in two steps means touching
`GrabModeDragOperation` twice.

**Store topology, which is the part that has to be right.** Note that `roomStore` is _already_ the
live view today — drags write to it, which is why 49 read sites across 20 files see live geometry
during a gesture. Preserving that meaning for `roomStore` is what keeps every reader untouched:

```ts
// 1a: the writable is renamed and demoted; `roomStore` keeps its name and its live meaning.
const committedRoom = writable<EditorDocument>(...);     // was `roomStore`
export const interaction = writable<Interaction>({ kind: 'idle' });
export const roomStore = derived(                        // same name, same live semantics
  [committedRoom, interaction],
  ([$doc, $i]) => previewDocument($doc, $i)
);

// dispatch is a plain function in 1a; it becomes a reducer action in 1b.
export function dispatch(c: EditorCommand) {
  committedRoom.update((doc) => applyCommand(doc, c));
}
```

- **Writers** (all 29, §3.2) become `dispatch(command)` calls, and the 13 `roomStore.ts` helper
  bodies move into command handlers. `historyStore` still infers by diffing in this phase — one
  dispatch produces one update, so it produces one entry, which is all 1a needs. Labels are defined
  by handlers now but not yet consumed; 1b consumes them.
- **Readers** change in exactly zero places. They keep `roomStore` and keep seeing live drags.
- **Persistence, autosave, and `historyStore`** are repointed to `committedRoom` — a small
  enumerable set, and the only sites that must _not_ see previews.
- In 1b, `committedRoom` is absorbed into `sessionStore`, `roomStore` re-points to the session's live
  view, and `committedDocument` is exported for the persistence set. Readers are untouched again.

The work itself:

- Introduce `EditorDocument` with nested `geometry` / `space` (§3.1) and migrate the in-memory type.
  Persistence keeps reading and writing the flat legacy shape in this phase — the translation lives
  in one adapter that 3a replaces with `documentCodec`.
- Add `EditorCommand`, the handler registry, `applyCommand`, and the dev-mode serializability
  assertion (§3.2, §3.4.1).
- Add `Interaction` (tagged union) and `previewDocument` (§3.2.1).
- Convert the six operations in `src/interactions/operations/` so `update()` returns a command and
  `cancel()` is deleted. `WallDragOperation` first — it is the smallest and already pure apart from
  `:90`. `GrabModeDragOperation` (302 lines) last; decide there whether a heterogeneous selection
  drag is one multi-entity command or a compound one.
- Collapse `DragManagerCallbacks`' seven writing callbacks into a return type; delete
  `onPauseHistory` / `onResumeHistory` and the `historyStore.pauseRecording` / `resumeRecording`
  primitives entirely.
- Wire `pointercancel` and window `blur` to cancel the interaction — not wired today.
- **Tests:** the command table (`(document, command) → document`, pure, no store) for all ~25
  handlers; per drag kind, a `(pointer sequence) → command` table asserting snap and axis-lock land
  correctly; each drag previews live, writes the committed document exactly once, writes nothing when
  it ends at its origin, and leaves it untouched on cancel; every dispatched command survives a JSON
  round-trip.
- **Ships value alone:** removes history suppression from the codebase, makes drag cancel correct by
  construction, stops autosave from ever capturing a mid-drag document, and makes the entire edit
  surface testable without a store.

### Phase 1b — session store + reducer (3–4 days)

- Introduce `Session`, `reduceSession`, and `sessionStore` (§3.1, §3.2.2). `modules` starts as an
  empty opaque map; no module system yet.
- Move every transition to a `SessionAction`: 1a's `dispatch` becomes `command.dispatch`, drag
  completion becomes `interaction.commit`, and `undo`/`redo` clear the interaction in the same
  emission (§3.2.1).
- Add the narrow derived stores (`roomStore`, `committedDocument`, `selection`, `history`,
  `diagnostics`), each guarded by reference equality; nothing else subscribes to `sessionStore`.
- Re-point `roomStore` (still the live derived view) and `committedRoom` at `sessionStore`; export
  the latter as `committedDocument`. Readers are untouched for the second time.
- Delete `historyStore`, `statesAreEqual`, and the `roomStore` subscription. History moves into the
  reducer with per-entry labels and `MAX_HISTORY = 50` (§3.1).
- `resetRoom()` becomes `open(emptyDocument())`.
- Add dev-mode deep-freeze on `open` and on every dispatch result (§3.4.1) and fix the mutations it
  surfaces.
- **Tests:** `reduceSession` as a pure table — no store, no Svelte, no DOM; the mixed-label sequence
  from §3.1; dispatch 51 times and assert the stack holds 50 with entry 1 evicted, then undo 50 and
  assert `past + future` is still 50; load pushes no undo entry; `open` clears interaction and
  selection; undo/redo mid-drag clears the interaction atomically, including when the restored
  snapshot no longer contains the dragged entity.
- **Ships value alone:** removes the O(document) `JSON.stringify` on every emission, gives undo
  entries real labels, fixes the load-pushes-undo bug that exists today, and reduces the state
  machine to one testable function.

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
lighting still reads its data from the document root, so 3b lands against a tested decoder rather
than an untested one.

- Define `ModuleCodec<T>` / `ModuleBlob` / `DecodeResult<T>` / `ModuleDataStatus` in
  `floorplan/types/module.ts`, the opaque `ModuleSlices` type with `readModule` / `withModule`,
  `defineCommand`, and the codec registry in `modules/codecs.ts`. No runtime manifest yet.
- Write `lighting/codec.ts` and `lighting/commands.ts` against the target `LightingData` shape
  (§7.3a), unused for now.
- Build `envelope.ts` + `documentCodec.ts` (§7.1): `DocumentEnvelopeV3` distinct from
  `EditorDocument`, permanent readers for 1 and 2 (§7.3) that nest geometry and lift `ceilingHeight`,
  quarantine, normalize-on-load / prune-on-save (§3.3) with the fresh-`defaultData()` baseline rule.
- The shared codec contract tests, which every future module inherits: fresh defaults (§3.4.1),
  share round-trip (§5.1), registration uniqueness (§5.4), command serializability (§3.2).
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

- Add `EditorDocument.modules` and `CarriedState`; move `lights` → `modules.lighting.fixtures`, plus
  `rafterConfig`, dead-zone and spacing config; convert lighting's edits to `lighting.*` commands and
  its drag preview to a candidate command like any other (§3.4).
- Move referenced custom light definitions into `LightingData.definitions` (§7.3a); demote the global
  `lightDefinitions` store to a picker library; replace the `mergeLightDefinitions` decode side
  effect with an explicit post-`open` adoption step; make `resolveDefinition` prefer the document's
  copy.
- Route **all** entry points through `documentCodec`, deleting 1a's temporary flat-shape adapter:
  `jsonImport`, `jsonExport`, `localStorage`, plus `shareUrl` on both sides. Every load ends in
  `sessionStore.open(loaded)`.
- Add the round-trip test for prune/normalize: load → visit a mode → save produces a value-identical
  document.
- **Risk:** share URLs in the wild encode envelope 1 and 2. Those readers are permanent — but they
  were already proven in 3a, which is the point of the split.

### Phase 4 — runtime manifest + move lighting (4–5 days)

- Define `ModuleRuntime`, `ModuleView`, `ModuleContext`, `ActivationScope`, and the full registry
  pairing codec + commands + `loadRuntime`.
- Implement the activation state machine (§5.3): dedup, generation token, scope-owned disposal of
  layers, handlers, shortcuts, subscriptions and async work, per-activation construction,
  `ModuleRuntimeStatus.failed` as session-disabled-but-data-live.
- Implement registration validation (§5.4) and wire the shared registry contract test.
- Physically move lighting files under `src/modules/lighting/`; author `runtime.ts`.
- Refactor `EditorRenderer` to `SceneLayer[]` taking a `ModuleView`; refactor `Canvas.svelte` and
  `Toolbar.svelte` to drive off the registry; repoint the phase-2 panel map at module manifests.
- Turn on the boundary lint rules for real, including the codec/commands/runtime isolation rule.
- **Tests:** activate → deactivate → activate leaves zero orphaned scene children and zero live
  subscriptions; a mode switch mid-load discards the stale resolution; disposing a scope aborts its
  signal; a rejected `loadRuntime` disables the mode and still round-trips the module's data through
  save.
- **This phase proves the seam using the module that already works** — if the contract is wrong,
  it is wrong against known-good behavior with an existing test suite, not against new flooring code.

### Phase 5 — Studio shell + routing (2–3 days)

- Extend `routerStore` beyond `'editor' | 'viewer'` to `#/{module}`, `#/{module}/viewer`, plus a
  mode-picker landing route.
- Preserve legacy URLs permanently: bare `#/` and `#/viewer` resolve to lighting.
- Module-aware share links (§7.5).
- Lazy-load runtimes via dynamic `import()`; verify with a bundle-size check that the IES parser and
  heatmap shaders are absent from the initial chunk, and that codecs and commands _are_ present.
- **Route-race tests** (§5.3): rapid `#/lighting` → `#/flooring` → `#/lighting` navigation, and a
  document open landing mid-activation, both ending with exactly one active module and no leaks.

### Phase 6 — flooring module (scope TBD, largest phase)

- Types: `PlankSpec` (width, length, thickness), `LayoutConfig` (run angle, start corner, stagger
  rule, min end-cut, expansion gap, row offset pattern), `Transition`.
- Commands: `flooring.layout.configure`, `flooring.origin.move`, `flooring.transition.add|remove` —
  the same shape as lighting's, absolute payloads, serializable.
- `PlankLayoutEngine`: pure function of (boundary, obstacles, config) → planks + cut list + waste %.
  **Output is derived, never stored** (§7.4a), computed as a projection meeting the requirements in
  §7.4 — narrow inputs, keyed cache, cancellable via the activation scope's signal, last-good-wins
  while recomputing. This is where the `Projection` interface gets designed, against a real engine.
- `PlankRenderer`: **`THREE.InstancedMesh` from the start.** A 400 sqft floor at 7"×48" planks is
  ~200 planks; the existing renderers rebuild meshes on every store change, which is fine at ~20
  lights and is not fine at 200+ planks with per-plank hit-testing.
- Panels: layout config, plank spec, cut list / waste summary.
- Reuse `Obstacle` polygons as cutouts and `Door` positions as threshold candidates directly.
- **Revisit the manifest-vs-capabilities question here** (§5.2), now that a second module exists to
  show whether the extension points actually diverge.

---

## 9. Risks

| Risk                                                                 | Mitigation                                                                                            |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Big-bang refactor stalls mid-way                                     | Eight implementation phases plus scaffolding, each shippable; 1a/1b/2/3a stand alone.                 |
| Rewriting six drag operations regresses interaction feel             | Phase 1a is standalone, against current stores; per-op command table plus live-preview test.          |
| Preview and commit diverge as drag logic evolves                     | Structurally impossible — the preview is the command that gets dispatched (§3.2.1).                   |
| Command registry becomes boilerplate nobody maintains                | ~25 handlers, most relocated from existing pure helper bodies; registration validation catches drift. |
| A command payload holds a live reference and mutates under preview   | Absolute payloads; dev-mode JSON round-trip assertion on every dispatch (§3.2, §3.4.1).               |
| Someone reimplements history as a command log                        | Called out in §3.2: inverses are a second implementation; snapshots + 50-cap stay.                    |
| Leaked THREE resources, subscriptions, or workers on mode switch     | Activation scope owns every disposer and an `AbortSignal`; generation token; race tests in 4 and 5.   |
| Duplicate module/command/tool/panel ids silently shadow              | Registration throws; shared registry contract test (§5.4).                                            |
| A compacted share payload fails the module's own decoder             | `compactForShare` returns `T`; share round-trip contract test per codec (§5.1).                       |
| Quarantined data reopened against materially different geometry      | Fingerprint in `CarriedState`, `geometryChangedSinceLoad` beside the blob, escalating warning (§7.2). |
| Runtime failure mistaken for data failure, dropping valid slices     | `ModuleDataStatus` and `ModuleRuntimeStatus` are separate types; runtime status never persisted.      |
| Runtime code mutates the document outside a command                  | `ModuleView` is deep-readonly and narrow; `ModuleContext` exposes `dispatch`, never the store.        |
| Custom light definitions lost or silently overridden on import       | Definitions move into `LightingData`; document copy wins; v2 conflict fixture (§7.3a).                |
| History grows unbounded once `MAX_HISTORY` is reimplemented          | Cap is in the reducer (§3.1); test that dispatch 51 evicts entry 1.                                   |
| `GrabModeDragOperation` (302 lines) is the hard conversion           | Convert it last in 1a, after the pattern is proven on `WallDragOperation`.                            |
| Reading committed where previewed is meant, or the reverse           | Visuals freeze mid-drag / saves capture half a gesture; named in §3.5, checked in review.             |
| Phase 1b must convert every transition atomically                    | Reads untouched; reducer is one exhaustive switch; flip `roomStore` to derived last.                  |
| Undo/redo labels desync after repeated undo                          | Labels ride with snapshots in `HistoryEntry`; mixed-sequence test in phase 1b (§3.1).                 |
| In-place mutation bypasses history, or drifts the prune baseline     | `DeepReadonly` at boundaries, dev deep-freeze, fresh-default contract test per codec (§3.4.1).        |
| Persistence concerns leak back into editor types                     | `DocumentEnvelopeV3` is a separate type; `documentCodec` is the only translator (§7.1).               |
| Existing share URLs break                                            | Envelope 1/2 readers are permanent; fixture tests land before the type change.                        |
| Undecodable module data silently lost on save                        | Quarantine held in `CarriedState`; value-identical round-trip test in phase 3.                        |
| Prune-on-save drops a slice a user meant to keep                     | Prune only on exact deep-equality with `defaultData()`; round-trip test in phase 3.                   |
| Codec bundle bloat defeats lazy loading                              | Lint rule bans `three` / `*.svelte` / `runtime.ts` imports from `codec.ts` and `commands.ts`.         |
| Plank layout blocks the frame on every pointer move                  | Projection requirements in §7.4: narrow inputs, keyed cache, cancellable, last-good-wins.             |
| `Canvas.svelte` (1052 lines) is a merge-conflict magnet              | Do phases 1–4 on short-lived branches; avoid parallel feature work in that file.                      |
| Module contract is wrong                                             | Phase 4 validates it against lighting (known-good, tested) before flooring exists.                    |
| History snapshots balloon with plank data                            | No field for derived output; round-trip test asserts the persisted slice shape.                       |
| Plank rendering perf                                                 | `InstancedMesh` + spatial hit-testing from the first commit, not retrofitted.                         |
| Product focus dilution (lighting designers vs. flooring contractors) | Mitigate with branding and entry points in phase 5, not with a code split.                            |

---

## 10. Out of scope

- Monorepo / workspace migration (revisit against the triggers in §1).
- 3D flooring visualization.
- Server-side persistence or accounts.
- Real-time collaboration. Commands make it reachable (§3.2) — serializable, absolute, one action per
  intent — but nothing in this plan builds toward it, and the delta-vs-absolute payload question
  would be reopened if it ever starts.
- Renaming `roomStore` → `editorStore`, and the `lumen_2d` package. Both cosmetic; do them as
  mechanical codemods once the structural phases have landed, or never.

---

## 11. Decision log

Designs that were proposed and superseded, kept so they are not re-proposed. Each was rejected for a
reason that still holds.

| Proposal                                                    | Superseded by                                          | Why                                                                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `pauseRecording` / `resumeRecording` around drags           | §3.2.1                                                 | A mode in which the document is written with history off; every review found another rule that mode needed.   |
| Scoped `Gesture` handle (`begin` / `apply` / `transact`)    | §3.2.1                                                 | Same mode, better packaged. Nesting, async, and leak rules were all reporting that the mode should not exist. |
| `commit(label, fn)` as the public write API                 | §3.2 commands                                          | Opaque callbacks cannot be named, logged, replayed, or tested without a store; label and behavior can drift.  |
| `commit` + `commitModule` as two entry points               | One `dispatch`; module edits are module-owned commands | A single action touching geometry and a slice needed both, and emitted twice.                                 |
| `DragResolution` + `applyDrag`, equal to commit by test     | §3.2.1 candidate commands                              | Two implementations held equal by a per-drag-kind test; the test was reporting the duplication.               |
| Separate public `dispatch` then `setInteraction`            | §3.2.2 reducer                                         | Two emissions and an observable incoherent `Session`.                                                         |
| `RoomState` as both editor and persisted type               | §7.1 `EditorDocument` vs `DocumentEnvelopeV3`          | Schema versions, quarantine, and legacy shapes leak into types the editor should not be able to name.         |
| Flat `walls` / `doors` / `obstacles` / `ceilingHeight` root | §3.1 nested `geometry` / `space`                       | Bakes "one room, with a ceiling" into the core type; blocks connected rooms and multiple polygons.            |
| One `disabled` flag for modules                             | §7.2 `ModuleDataStatus` + `ModuleRuntimeStatus`        | Conflates "we cannot read this data" with "this session cannot show it"; the second must not affect saves.    |
| `capabilities: ModuleCapability[]` on `ModuleRuntime`       | §5.2 optional manifest fields + §5.3 activation scope  | Same edit cost per new extension point; the real benefit (lifecycle) belongs to the scope. Revisit in 6.      |
| `Projection<I, O>` in the core contract now                 | §7.4 requirements + §5.2's `inputs?` seam              | No consumer yet; designing a projection framework before flooring repeats the monorepo mistake.               |
| "Derived output is unnameable from `codec.ts`"              | §3.4 behavioral enforcement                            | A lint rule is a guardrail, not a type-level proof; the round-trip tests are the actual guarantee.            |
| Global `lightDefinitions` carried in `CarriedState`         | §7.3a definitions in `LightingData`                    | `definitionId` would reference data outside the document; undo, export, and share each need a sync rule.      |
