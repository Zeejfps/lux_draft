# Studio Modularization Plan

**Status:** complete — all seven phases landed on `modules`; see
[Implementation progress log](#implementation-progress-log). Lighting and flooring are both
registered modules over a domain-agnostic core, and adding the second one changed three files in
`../../../src` outside its own directory.
**Created:** 2026-08-02
**Rejected alternatives and decision history:** [ADR 0001](../../adr/0001-studio-modularization.md)

## Goal

Extract a domain-agnostic floorplan editor so lighting and a new LVP flooring domain can share
geometry, interaction, persistence, and UI infrastructure without forking the application.

## Decision

Keep one repository and introduce a Studio shell with registered modules. Split into packages or
separate entry points only when another consumer needs an independent release cadence, the core is
worth publishing independently, or build times become painful.

**Product shape:** one Studio, one document, switchable modes. The room polygon is drawn once and
both plans live on it — a kitchen remodel plans the cans and the LVP against the same geometry. Two
separate apps cannot offer that, and it falls out for free once a document is `geometry + modules`.

A document contains shared geometry and metadata plus typed module slices:

- **Core:** boundary, doors, obstacles, space metadata, selection, history, persistence, snapping,
  measurement.
- **Lighting:** fixtures, rafter config, dead-zone and spacing settings, referenced custom
  definitions.
- **Flooring:** layout config, plank spec, transitions.
- **Derived and never persisted:** plank layouts, cut lists, heatmaps, shadows, statistics.

### What transfers unchanged

Most of the editor is domain-agnostic already — scene and input, geometry, interactions and drag
operations, core rendering, persistence, controllers, and UI primitives. Three pieces of domain luck
are worth planning around:

- **Obstacles are already floor cutouts.** Islands, cabinets, and hearths transfer with zero changes
  — the polygon type and its drawing, drag, and vertex-edit machinery are what flooring needs.
- **Doors are already thresholds.** `Door` carries wall id, offset, and width, which is exactly a
  transition's data.
- SnapEngine, PolygonValidator, DimensionLabel, and the measurement tool need nothing.

---

## Architectural invariants

Everything below is stated once here and referenced by number elsewhere.

1. **One `Session` value.** It owns the committed document, carried quarantine data, ephemeral
   interaction and selection state, session diagnostics, and snapshot history. Data lifetime is a
   position in a type, not a convention.
2. **Commands are the only way to edit a document.** `dispatch(command)` — one command, one history
   entry, one store emission. Commands are serializable data, handlers are pure
   `(document, command) => document`, and move/set commands carry absolute targets rather than deltas.
3. **A drag previews a candidate command and dispatches that same value on completion.** Preview and
   commit apply the identical command to the same committed base, so the last frame the user saw is,
   by construction, the state that gets committed. Nothing writes the document mid-gesture, so history
   is never suppressed.
4. **Every session transition is one reducer action.** `reduceSession(session, action)` is pure,
   total, and the whole state machine.
5. **Derived output is never stored.** It has no field on `Session`, no persistence API accepts it,
   and the codec round-trip test asserts the persisted shape.
6. **Modules receive a typed `ModuleView`, never the whole document or any store.** Writes leave a
   module only as a registered command.
7. **Codecs and command handlers load eagerly; rendering and UI runtimes load lazily.** This is what
   reconciles lazy modules with synchronous persistence.
8. **Unknown, invalid, or newer module blobs are preserved verbatim and never block geometry edits.**
   Geometry is the shared asset; only geometry validation failure rejects a document.
9. **All imports, local storage, exports, and share URLs pass through one document codec.** It is the
   only code that sees hostile, legacy, or partial input; everything downstream receives a valid,
   normalized document.

---

## Target model

### Document

```ts
// floorplan/types/document.ts

export interface WallLoop {
  walls: WallSegment[];
  isClosed: boolean;
}

/** The shared drawing. No module may add a field here. */
export interface FloorplanGeometry {
  boundary: WallLoop;
  doors: Door[];
  obstacles: Obstacle[];
}

/** Room-level facts that are not geometry and not owned by one module. */
export interface SpaceMetadata {
  ceilingHeight: number;
}

/** Editable, undoable, persisted. Nothing else belongs here. */
export interface EditorDocument {
  geometry: FloorplanGeometry;
  space: SpaceMetadata;
  displayPreferences?: DisplayPreferences;
  /** Opaque; reachable only via readModule / withModule. */
  modules: ModuleSlices;
}
```

Geometry is nested so `boundary: WallLoop` can become `boundaries: WallLoop[]` for connected rooms
and thresholds between spaces without rewriting modules — they read through views (invariant 6), not
through the document root.

### Session

```ts
// floorplan/types/session.ts

/** Persisted, never edited, never rendered. Carried from load to save. */
export interface QuarantinedSlice {
  blob: ModuleBlob;
  reason: 'unsupported' | 'invalid' | 'unknownModule';
  message?: string;
}

export interface CarriedState {
  quarantined: Readonly<Record<string, QuarantinedSlice>>;
  /** Structural hash of geometry at load time; drives the staleness flag. */
  geometryFingerprint: string;
}

/** Session-scoped. Not persisted, not undoable. */
export interface Diagnostics {
  warnings: DocumentWarning[];
  runtimeStatus: Readonly<Record<string, ModuleRuntimeStatus>>;
}

export interface HistoryEntry {
  document: EditorDocument;
  /** Names the action that changed the document away from this snapshot. */
  label: string;
}

export interface History {
  readonly past: readonly HistoryEntry[];
  readonly future: readonly HistoryEntry[];
}

export const undoLabel = (h: History) => h.past.at(-1)?.label ?? null;
export const redoLabel = (h: History) => h.future[0]?.label ?? null;

export interface Session {
  readonly document: DeepReadonly<EditorDocument>;
  readonly carried: DeepReadonly<CarriedState>;
  readonly selection: Readonly<Selection>;
  readonly interaction: DeepReadonly<Interaction>;
  readonly diagnostics: DeepReadonly<Diagnostics>;
  readonly history: History;
}
```

`DeepReadonly`, not bare `Readonly<T>`, which is shallow and would let `doc.geometry.doors.push(d)`
type-check. Mutable counterparts exist only inside `reduceSession`, the sole constructor of these
values.

**Labels ride with snapshots, not alongside the stacks.** An `undoLabel`/`redoLabel` pair of fields
can name the next undo but cannot survive repeated undo/redo — after "Move wall" then "Change ceiling
height", undoing twice must surface those two labels as redo labels in order, and that is not
recoverable from two arrays of bare documents.

**`MAX_HISTORY = 50`**, preserved from today. Eviction is oldest-first from `past` only; undo and
redo move entries between stacks rather than evicting, so the invariant is
`past.length + future.length ≤ MAX_HISTORY`.

### Commands

```ts
// floorplan/types/command.ts

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

/** Modules contribute their own; the core never names them. Built by defineCommand. */
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

/** Pure. Looks up the handler by `type`. The only document transform in the app. */
export function applyCommand(
  doc: DeepReadonly<EditorDocument>,
  command: EditorCommand
): EditorDocument;

/** Owns the module id and verb strings; wraps the handler in withModule. */
export function defineCommand<T, P>(
  codec: ModuleCodec<T>,
  verb: string,
  handler: {
    label(payload: P): string;
    apply(doc: DeepReadonly<EditorDocument>, payload: P, prev: Readonly<T>): T;
  }
): CommandKind<P>;
```

The common case — a command touching one module's slice — never sees the whole document. A handler
that must touch geometry _and_ a slice registers against the document form; it is still one command,
so still one history entry.

Three properties make the command layer worth its cost, and each is enforced rather than documented:

| Property                                   | Enforced by                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| Serializable data only                     | Dev-mode JSON round-trip assertion on dispatch; registry contract test |
| Move/set payloads are absolute, not deltas | Contract test over that family: applying twice equals applying once    |
| Pure handlers                              | Handlers take no store; command tables test with no store or DOM       |

**Absolute payloads are required of the move and set family only** — `wall.move`, `vertex.move`,
`door.move`, `obstacle.move`, `obstacle.vertex.move`, `wall.setLength`, `space.setCeilingHeight`, and
their module equivalents. That family is the one re-applied to the committed base on every frame of a
drag, so a delta would accumulate, and idempotence is what makes preview and commit the same value.
The add, insert, and remove commands are **not** idempotent and are not required to be — reapplying
an add duplicates, an insert inserts twice, a delete hits a different index. They are produced by
discrete clicks and never previewed per frame.

Serializability is what makes logging, replay, fixture-based testing, and any future collaboration
possible; without it `EditorCommand` is a tagged callback. Because the label comes from the handler it
cannot drift from the operation, and keyboard nudge, property-panel entry, and drag become three
producers of one command instead of three code paths.

**Commands are the write boundary, not the history representation.** A command log is the
obvious-looking optimization and needs inverses or replay-from-origin; snapshots stay.

### Interaction

```ts
// floorplan/types/interaction.ts

export type DragTarget =
  | { kind: 'vertex'; index: number }
  | { kind: 'wall'; id: string }
  | { kind: 'door'; id: string }
  | { kind: 'obstacle'; id: string }
  | { kind: 'obstacleVertex'; obstacleId: string; index: number }
  | { kind: 'moduleEntity'; moduleId: string; ids: readonly string[] };

/** Captured at pointer-down. Op-local; never read by the reducer. */
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

export function previewDocument(doc: DeepReadonly<EditorDocument>, i: Interaction): EditorDocument {
  return i.kind === 'commandPreview' ? applyCommand(doc, i.command) : (doc as EditorDocument);
}
```

Drag operations resolve pointer input into a command: `update(ctx) => EditorCommand`. Axis lock,
snapping, guides, and constraints stay in the operation — that geometry work is already pure today,
and `WallDragOperation` already captures its origin state and computes an absolute result. Putting
the result into a document is `applyCommand`'s job, and it is the same `applyCommand` the dispatch
uses. `drawing` and `measuring` stay separate variants: drawing has no command until the polygon
closes (`room.close` is the whole edit), and measuring never produces one.

The union also removes its own invalid states. `WallDragOperation` today encodes a two-state machine
in five nullable fields behind a six-clause guard; as a variant, the drag's data exists only in the
`commandPreview` case and "active but missing its origin" stops being expressible.

### Session store and reducer

```ts
// floorplan/stores/reduceSession.ts

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

```ts
// floorplan/stores/sessionStore.ts — every method is exactly one action, one emission
export const sessionStore = {
  subscribe,
  dispatch(command: EditorCommand): void,
  open(loaded: LoadedDocument): void,
  setInteraction(next: Interaction): void,
  cancelInteraction(): void,
  finishInteraction(): boolean,
  select(next: Selection): void,
  undo(): boolean,
  redo(): boolean,
};

/** Live view: committed document with the candidate command applied. What the editor renders. */
export const roomStore = derived(sessionStore, (s) => previewDocument(s.document, s.interaction));

/** What history, autosave, export, and share read. Never includes a preview. */
export const committedDocument = derived(sessionStore, (s) => s.document);
```

Rules that were previously call-site discipline are now cases in one switch:

| Action                                   | Result                                                                             |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| `command.dispatch`                       | Apply, push one labeled entry, evict past 50. Value-equal result → no-op, no entry |
| `interaction.commit`                     | Dispatch the previewed command, push history, and set `idle` — one value           |
| `history.undo` / `history.redo`          | Swap the document and clear the interaction together                               |
| `document.open`                          | Replace document, carried, diagnostics, history, selection, interaction at once    |
| `interaction.set` / `interaction.cancel` | Ephemeral only; no history, no persistence                                         |

Undo and redo must _clear_ the interaction, not coexist with it: a surviving candidate command would
be re-applied to the restored document using ids and vertex indices resolved against the pre-undo
one.

**Subscription granularity.** One `Session` means every pointer move notifies every subscriber.
Nothing subscribes to `sessionStore` directly except the narrow derived stores in that file
(`roomStore`, `committedDocument`, `selection`, `history`, `diagnostics`), each guarding with a
reference-equality check so it emits only when its own slice changed. Components subscribe to the
narrow stores; modules subscribe to neither and get a `ModuleView`.

**One new mistake becomes available:** reading `committedDocument` where `roomStore` is meant, or the
reverse. Derived visuals must read the preview or they freeze mid-drag; persistence must read
committed or it saves half a gesture. Both are one-line errors — a review checklist item.

### Immutability

`DeepReadonly` at every exported boundary is the primary defense. Two backstops close the gaps it
cannot, both statically eliminated from production behind a bare `if (import.meta.env.DEV)`:

- **Deep-freeze** on `open`, on every dispatch result, and on every `defaultData()` result — covering
  `JSON.parse` output, `structuredClone` results, and `as` casts. The freeze helper must have no
  retained side effects, or tree-shaking cannot drop it.
- **Command serializability assertion** on every dispatch.

Two failure modes justify this. A handler that mutates its `doc` and returns it makes the reducer's
equality check trivially true, so a real edit lands with no history entry. And a `defaultData()`
returning a shared object drifts the baseline prune-on-save compares against, so the slice is pruned
and the data silently dropped — surfacing long after the commit that caused it. The shared codec
contract test asserts `defaultData() !== defaultData()`.

### Selection

```ts
// floorplan/types/selection.ts
export type Selection =
  | { kind: 'none' }
  | { kind: 'wall'; id: string }
  | { kind: 'vertex'; indices: number[] }
  | { kind: 'obstacle'; id: string }
  | { kind: 'obstacleVertex'; obstacleId: string; indices: number[] }
  | { kind: 'door'; id: string }
  /** Extension point. Constructed only via SelectionKind. */
  | { kind: 'module'; moduleId: string; type: string; payload: unknown };

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
```

Cardinality is structural — `id: string` for single-select, `indices`/`ids` arrays for multi-select —
so "does this kind support multi-select" is answered by the type. Selecting anything replaces the
whole value, so cross-clearing is structural rather than six manual clears.

`defineSelection` writes the module id and type once and generates `make` and `match` from the same
pair, so producer and consumer cannot drift during a refactor — the actual failure mode the current
hand-written validating guard exists to catch. Panel dispatch uses the same `panelKey`, so
registration and dispatch cannot disagree.

### Module codec — eager (invariant 7)

```ts
// floorplan/types/module.ts — core owns this; it names no module
export interface ModuleCodec<T> {
  readonly id: string;
  readonly schemaVersion: number;
  /** Fresh slice for a document that has none. Cheap, pure, freshly allocated. */
  defaultData(): T;
  /** Never throws — returns a status. */
  decode(blob: ModuleBlob): DecodeResult<T>;
  /** Strip non-essential fields for share URLs. Defaults to identity. */
  compactForShare?(data: Readonly<T>): T;
}

export interface ModuleBlob {
  v: number;
  data: unknown;
}

export type DecodeResult<T> =
  | { status: 'ok'; data: T }
  | { status: 'unsupported'; writtenVersion: number; message: string }
  | { status: 'invalid'; message: string };

/** ModuleSlices is opaque — no index signature is exported, so these are the only doors. */
export function readModule<T>(
  doc: DeepReadonly<EditorDocument>,
  codec: ModuleCodec<T>
): Readonly<T>;
export function withModule<T>(
  doc: DeepReadonly<EditorDocument>,
  codec: ModuleCodec<T>,
  fn: (prev: Readonly<T>) => T
): EditorDocument;
```

The codec is the key, so call sites get `LightingData` rather than `unknown` and the id string is
written once. `withModule` is pure and takes no store, so it cannot become a second write path — its
result reaches the session only by being returned from a command handler.

`compactForShare` returns `T`, not `unknown`, and that is load-bearing: a compacted payload is written
at the current `schemaVersion` and read back by the ordinary decoder. A free-form return could produce
a link the module's own `decode` rejects, and the failure would appear as quarantined data on the
recipient's machine rather than as a bug on the sender's.

### Module runtime — lazy (invariant 7)

```ts
export interface ModuleRuntime {
  readonly id: string;
  readonly label: string;
  tools?: ToolDescriptor[];
  layers?(scene: THREE.Scene): SceneLayer[];
  handlers?(ctx: ModuleContext<unknown>): IInteractionHandler[];
  /** Keyed by SelectionKind.panelKey. */
  panels?: Record<string, ComponentType>;
  statsPanel?: ComponentType;
  shortcuts?: ShortcutDescriptor[];
  onActivate?(ctx: ModuleContext<unknown>, scope: ActivationScope): void;
}

/** What a module may read. Typed by its own codec. */
export interface ModuleView<T> {
  readonly geometry: DeepReadonly<FloorplanGeometry>;
  readonly space: DeepReadonly<SpaceMetadata>;
  readonly data: Readonly<T>;
  readonly selection: Readonly<Selection>;
}

/** Capabilities, not stores. */
export interface ModuleContext<T> {
  dispatch(command: EditorCommand): void;
  select(next: Selection): void;
  setInteraction(next: Interaction): void;
  view(): ModuleView<T>;
}

export interface SceneLayer {
  id: string;
  update(view: ModuleView<unknown>): void;
  /** Optional selector: skip update when these are reference-equal to the last call. */
  inputs?(view: ModuleView<unknown>): unknown;
  setVisible(v: boolean): void;
  dispose(): void;
}
```

Narrow views stop one module reading another's slice by accident, make a layer's dependencies legible
(what it re-derives from is the shape of its view), and remove the last handle by which runtime code
could reach the store and write outside a command. If two modules' needs diverge, the answer is
explicit core selectors composed into the view, not widening the view back to the whole document.

`SceneLayer` is close to what the existing renderers already expose; the change is narrowing `update`
so `EditorRenderer` can hold a `SceneLayer[]` and loop instead of naming each renderer as a field with
a bespoke method. Implement `inputs?` when flooring needs it, not before.

### Activation is an owned scope

```ts
type RuntimeState =
  | { status: 'unloaded' }
  | { status: 'loading'; token: number; promise: Promise<ModuleRuntime> }
  | { status: 'active'; runtime: ModuleRuntime; scope: ActivationScope }
  | { status: 'failed'; error: Error };

export interface ActivationScope {
  own(disposer: () => void): void;
  /** Aborted on disposal; pass to async work, projections, and workers. */
  readonly signal: AbortSignal;
}
```

`loadRuntime()` is asynchronous while mode switches, route changes, and document opens are not. Rules
that make that safe:

- **The scope is the unit of ownership.** Scene layers, input handlers, shortcut bindings, derived
  subscriptions, projection caches, workers, and pending async work all register with it. Naming only
  layers and handlers leaks the rest — flooring's layout engine holds a subscription and a worker.
- **Dedup.** A second `activate()` while `loading` returns the in-flight promise; `import()` is
  idempotent but the scope construction that follows is not.
- **Generation token.** Each activation increments a counter; a stale resolution constructs and
  disposes nothing, because it never built anything.
- **The registry owns disposal.** Modules never dispose their own contributions. `open(loaded)`
  deactivates before swapping documents, so no layer sees two unrelated documents.
- **The record is cached; the scope is not.** It binds a `THREE.Scene` and a `ModuleContext` and is
  rebuilt per activation — caching it is the straightforward way to leak a scene.

### Registration validates and fails fast

A duplicate string shadows silently, surfacing later as the wrong codec decoding a slice or a panel
rendering for the wrong selection. Registration throws on: duplicate module id;
`runtime.id !== codec.id`; duplicate command type, tool id, layer id, or panel key; a tool id or
command type not namespaced with the module id; an already-bound shortcut.

Shortcut precedence is explicit rather than registration-order: **core wins over modules, and a
module-vs-module conflict is a registration error** — detectable at registration even though only one
module is active at a time. All of this lives in a shared registry contract test every module runs
through.

---

## Persistence and lifecycle

### One codec, two types

```ts
// floorplan/persistence/envelope.ts — the on-disk shape, never used by the editor
export interface DocumentEnvelopeV3 {
  version: 3;
  geometry: unknown;
  space?: unknown;
  displayPreferences?: unknown;
  modules: Record<string, ModuleBlob>;
  /** Recorded beside a quarantined blob, never inside it. */
  quarantineFlags?: Record<string, { geometryChangedSinceLoad: boolean }>;
}

// floorplan/persistence/documentCodec.ts
export function decodeDocument(raw: unknown): LoadedDocument;
export function encodeDocument(
  document: DeepReadonly<EditorDocument>,
  carried: DeepReadonly<CarriedState>,
  target: EncodeTarget
): DocumentEnvelopeV3;

export type EncodeTarget =
  | { kind: 'file' }
  | { kind: 'local' }
  | { kind: 'share'; moduleId: string };

export interface LoadedDocument {
  document: EditorDocument;
  carried: CarriedState;
  diagnostics: Diagnostics;
}
```

Two types rather than persisting `EditorDocument` directly: the envelope carries schema versions,
omitted defaults, quarantined blobs, drift flags, and permanent legacy shapes, none of which the
editor should be able to name.

Today three entry points behave three different ways — `jsonImport` validates properly, `localStorage`
casts `JSON.parse(data) as RoomState` with ad-hoc shape sniffing and no validation, and `shareUrl`
delegates to import. Local storage is the weakest and will be the most common source of pre-migration
documents. All three converge here (invariant 9).

`decodeDocument` is **synchronous** — it touches only eagerly-imported codecs, so `importFromString`
and `decodeShareData` keep their signatures and no caller changes. `encodeDocument` is the only writer
of the envelope; `jsonExport.createExportData` folds into it. `carried` is a required positional
parameter, so a save path that forgets it fails to compile.

### Normalize on load, prune on save

An absent slice would create three states where two suffice — absent, default-but-unwritten, and
materialized — which is what forces read-time defaults and an "activation must never write" rule.

- **On load**, materialize `codec.defaultData()` for every registered module with live data.
- **On save**, omit any slice that deep-equals a **freshly allocated** default.

Reads become ordinary field reads, and visiting a mode for the first time serializes identically to
what was loaded, so an empty mode visit is not an edit. The baseline is never cached across calls: a
cached one is reachable from module code through the same reference that was normalized into the
document.

### Failure policy: data status vs. runtime status

```ts
/** Derived, not stored. Decode puts each id in exactly one of the two maps. */
export type ModuleDataStatus =
  | { kind: 'live' }
  | { kind: 'quarantined'; reason: QuarantinedSlice['reason']; message?: string };

export function moduleDataStatus(session: Session, id: string): ModuleDataStatus;

/** Session-scoped. Stored in Diagnostics, never in the document or envelope. */
export type ModuleRuntimeStatus =
  | { kind: 'inactive' }
  | { kind: 'loading' }
  | { kind: 'active' }
  | { kind: 'failed'; message: string };
```

**Data status is a classification, not stored state.** An id is live iff it is in `document.modules`
and quarantined iff it is in `carried.quarantined`; decode guarantees exactly one, asserted in dev.
`moduleDataStatus` reads the reason from `QuarantinedSlice`, which is why the reason lives beside the
blob rather than only in `Diagnostics.warnings` — the warnings are a user-facing presentation of that
classification, not a second source of truth for it. Runtime status is genuinely session state and is
the only one of the two with a stored field.

`live` data with a `failed` runtime is a real and important state: the module's import 404'd, WebGL
lacks an extension, or the layout engine threw during construction. The data decoded fine and is
written back at the current `schemaVersion` exactly as if the mode had been visited.

| Case                                   | Data status                    | Effect                                                        |
| -------------------------------------- | ------------------------------ | ------------------------------------------------------------- |
| Geometry invalid                       | —                              | **Reject the document.** Throw `ValidationError` as today.    |
| Module slice absent                    | `live`                         | Normalized to `defaultData()` during decode.                  |
| Module slice `ok`                      | `live`                         | Editable via commands.                                        |
| Module slice `unsupported` (newer `v`) | `quarantined: 'unsupported'`   | Blob verbatim in `carried`; warn "saved by a newer version".  |
| Module slice `invalid`                 | `quarantined: 'invalid'`       | Blob verbatim; warn with the codec's message.                 |
| No codec registered for the id         | `quarantined: 'unknownModule'` | Blob verbatim; no warning (expected in single-module builds). |
| Runtime failed to load                 | unchanged (`live`)             | `runtimeStatus: failed`. Data saves normally. Mode hidden.    |

Quarantined means: mode not selectable, no default materialized, the blob written back unchanged, and
no slice for a module command to read or target. **Handlers stay registered** — registration is per
installed module and static (invariant 7), so nothing unregisters `lighting.*` because one document's
lighting blob failed to decode. Dispatching a module command whose slice is quarantined is a no-op
and a dev assert; no UI path can produce one, because the mode is not selectable.

Runtime-failed means: mode not selectable this session, nothing else changes. In both cases geometry
and the other module stay fully editable (invariant 8).

**Staleness.** Preserving a blob verbatim while the user reshapes the room means a future build may
reopen data authored for a different polygon — and a flooring layout computed for the old room is
wrong in a way that looks authoritative. `CarriedState` captures a geometry fingerprint at load; if it
no longer matches at save, the envelope records `geometryChangedSinceLoad` beside the blob. The in-app
warning escalates on the first geometry command. We never silently discard work, and never let
unparseable data freeze the editor.

### Merge precedence — quarantined vs. live

| Rule                         | Behavior                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| `target: 'file'` / `'local'` | Live slices at `codec.schemaVersion`, defaults pruned; quarantined blobs merged back verbatim. |
| `target: 'share'`            | Quarantined blobs omitted entirely, along with all non-target live slices.                     |
| Same id in both maps         | Live wins — and is a bug; assert in dev. Decode puts each id in exactly one map.               |
| Target module quarantined    | **Not shareable.** The share UI blocks it; `encodeDocument` throws if asked.                   |
| Target module runtime failed | **Shareable.** The data is live and valid; only this session's UI is unavailable.              |

A quarantined blob is by definition one this build could not decode, so it cannot be compacted,
validated, or rendered by a viewer — a share link for it would fail on open.

### Versioning — two independent levels

`ExportData.version: 1 | 2` already exists but versions the _light-definition envelope_, not the
document schema. Overloading it would give one number two meanings.

- **Envelope `version: 3`** means modules-shaped with nested geometry. Readers for 1 and 2 are
  **permanent, not transitional** — legacy share URLs encode them. They nest the flat shape under
  `geometry`, lift `ceilingHeight` into `space`, and lift `lights`, `rafterConfig`, and
  `lightDefinitions` into `modules.lighting`.
- **Per-module `v`**, owned and migrated by that module's codec. A module revises its schema without
  touching the envelope version or any other module.

### Custom light definitions belong to the document

`ExportData.lightDefinitions` carries custom fixture definitions that `lights[].definitionId`
references. It is neither geometry nor an opaque blob nor derived output — it is a referenced asset
library, and today it is a global side effect with a live bug: import merges only ids not already
present, so opening a share link whose `custom-abc` differs from your local `custom-abc` silently
drops the sender's and renders their fixtures with your photometry. It also makes decode impure.

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

A document that renders differently depending on which machine opens it is broken, and this is the
minimal change to what is on disk — v2 already embeds exactly this closure, so migration moves an
array rather than recomputing it. Decode becomes pure; the global store demotes to a picker library
with its own localStorage key; adoption of unknown incoming definitions becomes an explicit
post-`open` step; `resolveDefinition` prefers the document's copy, which is the fix; and
`compactForShare` keeps the closure.

### Derived data is a projection over narrow inputs

Planks are a pure function of (boundary, obstacles, `LayoutConfig`). Storing them would put thousands
of objects into every one of 50 history snapshots. Store the config, derive the layout — which also
gives correct undo granularity for free, stepping through user intent rather than machine output.

A Svelte `derived` store is not sufficient for flooring: recomputing a plank layout synchronously in a
subscription would run on every pointer move of a wall drag and block the frame. Requirements for the
flooring projection, to be met in phase 6:

- **Narrow inputs** — derive from `(boundary, obstacles, layoutConfig)`, not from `Session` and not
  from the whole view; a selection change must not invalidate a layout.
- **Keyed cache** — memoize on a structural key, so undo/redo across a config change is a hit.
- **Cancellable** — take the activation scope's `AbortSignal`.
- **Last-good-wins** — keep serving the previous layout while a new one computes, so dragging a wall
  degrades to a stale floor rather than an empty one.
- **Relocatable** — nothing may assume the computation is synchronous, so moving it to a worker is a
  change inside the flooring module.

The interface expressing this is deliberately not specified until there is a consumer. `inputs?` on
`SceneLayer` is the seam; the requirements above are the acceptance criteria.

### Share URLs are module-aware

New links emit `#/{moduleId}/viewer?d=...` — the module is in the path, not inferred from persisted UI
state, which does not travel with a link. Legacy `#/viewer` is a permanent alias for
`#/lighting/viewer`. The share dialog picks the module explicitly, defaulting to the active mode, and
`compactForShare` runs on the target while all other slices are omitted: a share link is a
single-module view, and the 8000-character warning threshold does not survive carrying both.

---

## Current blockers

Three things make the core lighting-aware. Everything else is a file move.

**A. `RoomState.lights` is a hardcoded field.** `types/state.ts` puts `lights: LightFixture[]` on the
shared document and `types/index.ts` re-exports `./lighting` from the shared barrel. `jsonImport`
hard-requires `obj.lights` to be an array, `jsonExport` and `shareUrl` both read `state.lights`
directly to find used definitions, and `DEFAULT_ROOM_STATE` seeds it. `rafterConfig` and the
referenced custom definitions have the same problem. All move into `modules.lighting`; `ceilingHeight`
moves to `space`; the flat root becomes nested `geometry` at the same time, since both are one type
change and one migration.

**B. Selection is six parallel stores.** `appStore.ts` holds `selectedLightIds`, `selectedWallId`,
`selectedVertexIndices`, `selectedDoorId`, `selectedObstacleId`, `selectedObstacleVertexIndices`.
Every `select*` manually clears the other five; `clearSelection` and `setActiveTool` each clear all
six. Adding plank, course, and transition selections would make eleven mutually-clearing stores — the
bug surface grows quadratically. Target: the `Selection` union in `Session`.

**C. `EditorRenderer`, `Canvas.svelte`, and `Toolbar.svelte` name every domain.** `EditorRenderer`
constructs all seven renderers including `LightRenderer` and exposes lighting-specific facade methods.
`Canvas.svelte` (~1050 lines) declares every renderer and handler plus a `current*` mirror per
selection store, wired by hand in `onMount`. `Toolbar.svelte` (~915 lines) hardcodes each tool against
a closed `Tool` union. Target: `EditorRenderer` owns core layers and a `SceneLayer[]`; `Canvas` asks
the registry for the active module's scope and loops; `Toolbar` renders `registry.tools()`. Do this
**after** A and B — both simplify it, and the six `current*` mirrors collapse to one once selection
lives in `Session`.

---

## Target structure

```
src/
  floorplan/          # domain-agnostic editor core
    core/ geometry/ interactions/ rendering/ ui/
    commands/         # command registry + core handlers, one file per noun
    stores/           # sessionStore, reduceSession, derived views, settings, theme
    persistence/      # envelope, documentCodec, localStorage, json, shareUrl
    types/            # geometry, document, session, command, module, interaction, selection
  modules/
    codecs.ts         # eager barrel: every module's codec + commands, statically imported
    lighting/
      codec.ts        # EAGER — schema, defaults, decode, compactForShare
      commands.ts     # EAGER — defineCommand handlers over LightingData
      runtime.ts      # LAZY  — tools, layers, handlers, panels, stats
    flooring/         # (new) same shape
  app/                # Studio shell: mode picker, routing, toolbar composition, registry
```

`commands.ts` is eager alongside the codec: a module's edits must be dispatchable before its runtime
loads — an undo arriving during a mode switch, a share link opening straight into a document.

Boundaries are directories plus lint rules (`eslint-plugin-import` or `eslint-plugin-boundaries`), not
packages. The repo already runs `knip` and `jscpd`, so mechanical enforcement fits:

- `floorplan/**` may not import from `modules/**` or `app/**`.
- `modules/a/**` may not import from `modules/b/**`.
- `modules/*/codec.ts` and `modules/*/commands.ts` may not import their own `runtime.ts`, `three`, or
  `*.svelte`.
- `app/**` may import from anywhere.

The codec/runtime rule keeps the eager bundle small — without it one stray import pulls the IES parser
into every bundle. It also discourages storing derived output, but the guarantee there is invariant
5's round-trip test, not the lint rule.

---

## Implementation phases

Each phase is independently shippable and leaves `main` green. Run `npm run test:run`,
`npm run type-check`, and `npm run lint` at every boundary. The split points are deliberate: **1a is
the edit model, 1b is state, 3a/3b are the data plane, 4 is the UI plane.** Do phases 1–4 on
short-lived branches and avoid parallel feature work in `Canvas.svelte`.

### Phase 0 — scaffolding (½ day)

Add the import-boundary lint rule with the target layout allow-listed and nothing yet to police, so
each subsequent phase is validated as it lands.

### Phase 1a — commands and candidate-command previews (5–6 days) ← start here

Ships against the _current_ stores, so 1b inherits a codebase that already has a single inspectable
write model. Commands land here rather than in 1b because the drag operations are rewritten in this
phase either way; splitting means touching `GrabModeDragOperation` twice.

Store topology is the part that has to be right. `roomStore` is _already_ the live view today — drags
write to it, which is why every read site sees live geometry during a gesture. Preserving that meaning
is what keeps readers untouched:

```ts
const committedRoom = writable<EditorDocument>(...);     // was `roomStore`
export const interaction = writable<Interaction>({ kind: 'idle' });
export const roomStore = derived(                        // same name, same live semantics
  [committedRoom, interaction],
  ([$doc, $i]) => previewDocument($doc, $i)
);
export function dispatch(c: EditorCommand) {             // becomes a reducer action in 1b
  committedRoom.update((doc) => {
    const next = applyCommand(doc, c);
    return deepEqual(next, doc) ? doc : next;           // no-op detection lives here, not in history
  });
}
```

Tasks:

- Introduce `EditorDocument` with nested `geometry`/`space`. Persistence keeps reading and writing the
  flat legacy shape via one adapter that 3b deletes.
- Add `EditorCommand`, the handler registry, `applyCommand`, and the dev-mode serializability
  assertion. Existing `roomStore.ts` helper bodies are already `(state) => newState`; converting them
  is relocating a body into `CommandHandler.apply`.
- Add `Interaction` and `previewDocument`.
- Convert the drag operations so `update()` returns a command and `cancel()` is deleted;
  `WallDragOperation` first (smallest, already pure but for one line), `GrabModeDragOperation` last —
  decide there whether a heterogeneous selection drag is one multi-entity command or a compound one.
- Collapse `DragManagerCallbacks`' writing callbacks into a return type; delete the history
  pause/resume primitives entirely.
- Convert every writer to `dispatch`. `historyStore` still infers by diffing this phase — one dispatch
  is one update, so one entry, which is all 1a needs. Handler labels exist but are unconsumed until 1b.
- Put value-equality no-op detection in `dispatch` itself, returning the same reference so the store
  does not emit. Do not rely on `historyStore`'s `JSON.stringify` diff to swallow no-op drags: it
  happens to today, but 1b deletes that diff, and the guarantee must survive the deletion.
- Repoint persistence, autosave, and `historyStore` at `committedRoom` — the only sites that must not
  see previews.
- Wire `pointercancel` and window `blur` to cancel the interaction. Not wired today.

Acceptance criteria:

- A pure `(document, command) → document` table covers every handler, running with no store or DOM.
- Per drag kind, a `(pointer sequence) → command` table asserts snap and axis-lock land correctly.
- Each drag previews live, writes the committed document exactly once, and leaves it untouched on
  cancel. A drag ending at its origin dispatches a command that produces a reference-equal document,
  so the store does not emit and no history entry appears.
- Every dispatched command survives a JSON round-trip value-identically.
- For the move and set family only: applying a command twice equals applying it once.

**Key risk:** rewriting the drag operations regresses interaction feel. Mitigated by landing against
current stores with per-op tests, and by converting `GrabModeDragOperation` last.

### Phase 1b — session store and reducer (3–4 days)

Selection lives inside `Session`, so doing selection before this means doing it twice.

Tasks:

- Introduce `Session`, `reduceSession`, `sessionStore`. `modules` starts an empty opaque map.
- Move every transition to a `SessionAction`; drag completion becomes `interaction.commit`; undo and
  redo clear the interaction in the same emission.
- Add the narrow derived stores, each reference-equality guarded.
- Repoint `roomStore` and `committedRoom` at `sessionStore`; export the latter as `committedDocument`.
  Readers untouched for the second time.
- Delete `historyStore`, `statesAreEqual`, and the `roomStore` subscription. History moves into the
  reducer with per-entry labels and `MAX_HISTORY`.
- `resetRoom()` becomes `open(emptyDocument())`.
- Add dev-mode deep-freeze and fix the mutations it surfaces.

Acceptance criteria:

- `reduceSession` is tested as a pure table — no store, no Svelte, no DOM.
- Mixed label sequence: dispatch A, dispatch B, undo, undo, redo — assert the undo/redo label pair at
  every step.
- Dispatch 51 times → `past` holds 50 with entry 1 evicted; then undo 50 → `past` 0, `future` 50, sum
  still 50.
- Loading a document pushes no undo entry; `open` clears interaction and selection.
- Undo/redo mid-drag clears the interaction atomically, including when the restored snapshot no longer
  contains the dragged entity.

**Key risk:** breadth. Making `roomStore` derived breaks every writer at once, so `sessionStore` lands
alongside the writable, writers migrate, and `roomStore` flips to derived last.

### Phase 2 — unified selection (2–3 days)

Tasks:

- Introduce the `Selection` union as a `Session` field, plus `defineSelection`.
- Add a minimal panel registry: a `Map<string, ComponentType>` keyed by `panelKey`, populated
  statically in `App.svelte`. ~20 lines, no module system. Phase 4 changes only where it is populated
  _from_; the dispatch seam is written once, here.
- Migrate call sites store-by-store behind derived shims so components convert incrementally, then
  delete the shims and the six stores.

Acceptance criteria: no `select*` function clears a sibling store; panel dispatch resolves through
`panelKey` for both core and module selections.

**Key risk:** `Canvas.svelte` mirrors each store into a local `current*`; those subscriptions must
convert together or the canvas renders against stale selection.

### Phase 3a — codec infrastructure and fixtures (3–4 days)

No live data moves. This builds the pipeline and proves it against fixtures while lighting still reads
from the document root, so 3b lands against a tested decoder.

Tasks:

- Define `ModuleCodec` / `ModuleBlob` / `DecodeResult` / `QuarantinedSlice`, the opaque `ModuleSlices`
  with `readModule` / `withModule`, `defineCommand`, and the registry in `modules/codecs.ts`.
- Write `lighting/codec.ts` and `lighting/commands.ts` against the target `LightingData`, unused for
  now.
- Build `envelope.ts` and `documentCodec.ts`: v3, permanent v1/v2 readers, quarantine, normalize/prune
  with the fresh-default baseline.
- Wire the shared contract tests every future module inherits: fresh defaults, share round-trip,
  registration uniqueness, command serializability.

Fixtures, written before anything reads them: envelope v1; v2; **a v2 file with a referenced `custom-`
definition plus a conflicting local definition of the same id**; a future-version module blob; a
corrupt blob; an unknown module id.

Acceptance criteria:

- Each fixture migrates to the asserted shape, with the expected quarantine behavior and drift flag.
- Quarantined blobs round-trip **value-identically** through decode → encode → decode. Not
  byte-identically: the blob has been through `JSON.parse`, so key order, whitespace, escapes, and
  numeric spelling may change. Preserving the JSON _value_ is what a future build needs.
- The conflicting-definition fixture keeps the document's photometry, not the local library's.

### Phase 3b — move lighting data into the slice (3–4 days)

Tasks:

- Add `EditorDocument.modules` and `CarriedState`; move fixtures, rafter config, dead-zone and spacing
  settings into `modules.lighting`; convert lighting edits to `lighting.*` commands and its drag to a
  candidate command like any other.
- Move referenced custom definitions into `LightingData.definitions`; demote the global store to a
  picker library; replace the merge-on-decode side effect with an explicit post-`open` adoption step;
  make `resolveDefinition` prefer the document's copy.
- Route every entry point through `documentCodec`, deleting 1a's flat-shape adapter. Every load ends in
  `sessionStore.open(loaded)`.

Acceptance criteria: load → visit a mode → save produces a value-identical document; a slice equal to
its default is pruned; the phase-3a fixtures still pass against live data paths.

**Key risk:** share URLs in the wild encode envelope 1 and 2 — but those readers were proven in 3a,
which is the point of the split.

### Phase 4 — runtime manifest and move lighting (4–5 days)

This phase validates the module contract against the module that already works, with an existing test
suite, before flooring exists to confuse a contract failure with a new-code failure.

Tasks:

- Define `ModuleRuntime`, `ModuleView`, `ModuleContext`, `ActivationScope`, and the registry pairing
  codec + commands + `loadRuntime`.
- Implement the activation state machine and registration validation; wire the registry contract test.
- Physically move lighting under `../../../src/modules/lighting`; author `runtime.ts`.
- Refactor `EditorRenderer` to `SceneLayer[]` taking a view; drive `Canvas.svelte` and `Toolbar.svelte`
  off the registry; repoint the phase-2 panel map at module manifests.
- Turn on the boundary lint rules for real, including codec/commands/runtime isolation.

Acceptance criteria:

- activate → deactivate → activate leaves zero orphaned scene children and zero live subscriptions.
- A mode switch mid-load discards the stale resolution; disposing a scope aborts its signal.
- A rejected `loadRuntime` disables the mode and still round-trips the module's data through save.

**Key risk:** the module contract is wrong. Cheapest to discover here.

### Phase 5 — Studio shell and routing (2–3 days)

Tasks:

- Extend `routerStore` beyond `'editor' | 'viewer'` to `#/{module}`, `#/{module}/viewer`, plus a
  mode-picker landing route. Bare `#/` and `#/viewer` resolve to lighting, permanently.
- Module-aware share links.
- Lazy-load runtimes via dynamic `import()`.

Acceptance criteria: a bundle check confirms the IES parser and heatmap shaders are absent from the
initial chunk and that codecs and commands _are_ present; rapid `#/lighting` → `#/flooring` →
`#/lighting` navigation and a document open landing mid-activation each end with exactly one active
module and no leaks.

### Phase 6 — flooring module (scope TBD, largest phase)

Tasks:

- Types: `PlankSpec`, `LayoutConfig` (run angle, start corner, stagger rule, min end-cut, expansion
  gap, row offset pattern), `Transition`.
- Commands: `flooring.layout.configure`, `flooring.origin.move`, `flooring.transition.add|remove` —
  same shape as lighting's, absolute payloads, serializable.
- `PlankLayoutEngine`: pure function of (boundary, obstacles, config) → planks + cut list + waste %.
  Output is derived, never stored, computed as a projection meeting the requirements above. This is
  where the projection interface gets designed, against a real engine.
- `PlankRenderer`: `THREE.InstancedMesh` from the first commit. A 400 sqft floor at 7"×48" is ~200
  planks; the existing renderers rebuild meshes on every store change, which is fine at ~20 lights and
  is not fine at 200+ planks with per-plank hit-testing.
- Panels: layout config, plank spec, cut list and waste summary. Reuse `Obstacle` polygons as cutouts
  and `Door` positions as threshold candidates directly.
- Revisit the manifest-vs-capabilities question now that a second module exists (ADR 0001).

**Key risk:** plank layout blocks the frame on pointer moves. Mitigated by the projection
requirements; `InstancedMesh` and spatial hit-testing are not retrofitted.

---

## Cross-cutting risks

Phase-specific risks sit with their phases. These span the whole effort:

| Risk                                                                | Mitigation                                                                                      |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| The refactor stalls mid-way                                         | Seven phases plus scaffolding; 1a, 1b, 2, and 3a each ship value alone.                         |
| Reading committed where previewed is meant, or the reverse          | Visuals freeze mid-drag / saves capture half a gesture. One-line errors — review checklist.     |
| In-place mutation bypasses history, or drifts the prune baseline    | `DeepReadonly` at boundaries, dev deep-freeze, fresh-default contract test per codec.           |
| Duplicate module / command / tool / panel ids shadow silently       | Registration throws; shared registry contract test.                                             |
| Leaked THREE resources, subscriptions, or workers on mode switch    | Activation scope owns every disposer and an `AbortSignal`; generation token; race tests in 4–5. |
| Undecodable module data silently lost on save                       | Quarantine in `CarriedState`; value-identical round-trip fixtures in 3a.                        |
| Existing share URLs break                                           | Envelope 1/2 readers are permanent; fixtures land before the type change.                       |
| History snapshots balloon with derived data                         | No field for it; round-trip test asserts the persisted slice shape.                             |
| Codec bundle bloat defeats lazy loading                             | Lint bans `three` / `*.svelte` / `runtime.ts` from codecs and commands; bundle check in 5.      |
| Product focus dilutes (lighting designers vs. flooring contractors) | Branding and entry points in phase 5, not a code split.                                         |

---

## Out of scope

- Monorepo or workspace migration — revisit against the triggers in **Decision**.
- 3D flooring visualization.
- Server-side persistence or accounts.
- Real-time collaboration. Commands make it reachable — serializable, absolute, one action per intent
  — but nothing here builds toward it, and the delta-vs-absolute payload question would reopen.
- Renaming `roomStore` → `editorStore`, and the `lumen_2d` package. Both cosmetic. `roomStore` keeps
  its name through 1a and 1b deliberately: every read site depends on it, and renaming while replacing
  the write model doubles the blast radius for no structural gain. Do them as mechanical codemods after
  the structural phases land, or never.

---

## Implementation progress log

Each phase agent appends one entry here **before finishing**, so the next phase inherits what actually
happened rather than what was planned. Record deviations from the spec above, anything the next phase
must know, and anything deliberately deferred. Keep entries short and factual.

| Phase | Status | Branch / commit     | Notes                                                                                                                                                                               |
| ----- | ------ | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | done   | `modules` / c876e7e | Boundary rules live in `../../../eslint.config.js`; inert until the target dirs exist. Add new module ids to `MODULE_IDS` there.                                                    |
| 1a    | done   | `modules` / f8c125e | Commands are the only write path; `roomStore` is now a derived live view over `committedRoom` + `interaction`. Read sites moved to the nested `EditorDocument` shape.               |
| 1b    | done   | `modules` / e738251 | One `Session` behind `sessionStore` + pure `reduceSession`; `roomStore`/`committedDocument` are guarded derived slices. `historyStore` and `settingsStore`'s mirror are gone.       |
| 2     | done   | `modules` / db7a4ef | One `Session.selection`; the six `appStore` writables and every manual cross-clear are gone. `defineSelection` + a `panelKey` panel registry populated in `App.svelte`.             |
| 3a    | done   | `modules` / aa7b1a6 | Codec pipeline built and proven against fixtures; no live data moved. `documentCodec` reads a core registry the eager barrel `modules/codecs.ts` pushes into. 454 tests pass.       |
| 3b    | done   | `modules` / 3e0d291 | Lighting data lives in `modules.lighting`; every entry point routes through `documentCodec` and ends in `sessionStore.open`. `legacyDocumentAdapter` and `RoomState` are gone.      |
| 4     | done   | `modules` / e15e681 | Module runtime manifest, activation scope and the entity seam; `src/{floorplan,modules,app}` exist and the boundary lint is live. `EditorRenderer` is a `SceneLayer[]` loop.        |
| 5     | done   | `modules` / 99ed779 | Routes are `#/{module}`, `#/{module}/viewer` and `#/modes`; `ModuleRuntime` gained `overlays` and `surfaces` so the shell imports no module UI. `npm run check:bundle` is the gate. |
| 6     | done   | `modules` / 5867daa | The flooring module: types, codec, five commands, a pure `PlankLayoutEngine`, the projection, an `InstancedMesh` renderer with a spatial index, and three panels. 625 tests pass.   |

### Deviations

#### Phase 0

- **Two rules, not one.** `import/no-restricted-paths` (from `eslint-plugin-import`, added as a
  devDependency) encodes the `floorplan/` and cross-module zones against _resolved_ paths — needed
  because a sibling import `../flooring/x` from `modules/lighting/` is indistinguishable from a local
  subdirectory by specifier string alone. Core `no-restricted-imports` adds a specifier-string
  backstop for the `floorplan/` boundary (fires even when the target does not resolve, e.g. a
  `*.svelte` import) and carries the codec/commands isolation rule, which is purely string-shaped
  (`three`, `**/*.svelte`, `runtime`). `eslint-plugin-boundaries` was not used; both of its likely
  configurations need the same resolver setup and buy nothing extra here.
- **No `eslint-import-resolver-typescript`.** It conflicts on peers with the pinned
  `typescript-eslint@8.54`. Instead the built-in node resolver is configured with
  `extensions: ['.ts', '.js', '.mjs', '.svelte', '.json']`, which resolves this repo's extensionless
  relative imports (including directory `index.ts` barrels). If path aliases are ever introduced,
  this resolver setting must be revisited.
- **Cross-module zones are generated from a `MODULE_IDS` list** (`['lighting', 'flooring']`) at the
  top of `../../../eslint.config.js`, since `no-restricted-paths` zones cannot express "any other sibling".
  **A new module must be added to that array or it gets no cross-module enforcement.**
- Only `import/no-restricted-paths` is enabled from `eslint-plugin-import`; no other rule from that
  plugin (e.g. `import/no-unresolved`) was turned on, to avoid noise on the existing tree.
- Rules were verified against throwaway fixture files under `../../../src/floorplan`, `src/modules/*`, and
  `../../../src/app` that reproduced each violation; the fixtures were deleted before committing. No
  production code was moved.

#### Phase 1a

Commits: `65d8639` (implementation), `68bb3ad` (tests), `f8c125e` (dead-wrapper cleanup).

**Shape of the document, and the blast radius the plan does not mention.**

- `EditorDocument` lives in `src/types/document.ts` with nested `geometry`/`space` as specified,
  **plus `lights` and `rafterConfig` still at the document root** — `modules` does not exist until
  3b, and lighting data has to live somewhere. Both fields are commented as legacy.
- `roomStore` now emits `EditorDocument`, not `RoomState`. Preserving the store's _name_ and its
  _live_ semantics does not preserve its field paths, so **every read site moved**
  (`$roomStore.walls` → `$roomStore.geometry.boundary.walls`, `.ceilingHeight` →
  `.space.ceilingHeight`, `.doors ?? []` → `.geometry.doors`, and so on) across the components,
  the viewer, the derived stores, and the interaction handlers. This is unavoidable in 1a if 1b is
  to leave readers untouched, but it is much larger than "readers are untouched" suggests.
- `InteractionContext.roomState` and `DragStartContext.roomState` were renamed to `document` and
  retyped to `EditorDocument`. The `RoomState*` config interfaces in
  `interactions/types/configInterfaces.ts` kept their names — they are getter bundles, not the
  document type — and phase 4 can rename them for free.
- `RoomState` survives as the **wire** type only. `src/persistence/legacyDocumentAdapter.ts` is
  the one adapter (`toLegacyRoomState` / `fromLegacyRoomState`); local storage, JSON
  import/export, and share URLs call it at their boundary and 3b deletes the file. Public
  signatures of `importFromString`, `decodeShareData`, `loadFromLocalStorage`,
  `generateShareUrl`, `getJSONString`, `saveToLocalStorage` now take/return `EditorDocument`.
- `GeometryService` was retyped from `RoomState` to `WallLoop` and returns walls rather than
  documents, so command handlers can use it without knowing the document shape.

**Commands (`src/commands/`, one file per noun, `registry.ts` holds the table).**

- Names that differ from the plan's sketch:
  - `room.close` carries `walls: WallSegment[]`, not `vertices: Vector2[]` — `WallBuilder` already
    produces walls with ids and lengths, and regenerating them would churn wall ids (doors
    reference them).
  - `door.move` is `{ doorId, offset }`; `wallId` is omitted because nothing today moves a door
    between walls. Add it when something does.
  - `obstacle.move` is `{ obstacleId, vertices: Vector2[] }` (absolute position for every vertex,
    in index order), not `{ origin }` — an obstacle is stored as a wall loop and has no origin
    field. It stays absolute and idempotent.
  - **Extra commands the plan does not list, all required because 1a must convert every writer:**
    `door.set`, `obstacle.set`, `light.add`, `light.move`, `light.set`, `light.remove`,
    `lighting.setRafterConfig`, `document.setDisplayPreferences`. The `light.*` and
    `lighting.setRafterConfig` handlers are the ones 3b re-registers as module commands over
    `LightingData`; the others are core.
  - `compound` — see below.
- `MOVE_AND_SET_COMMAND_TYPES` in `src/types/command.ts` is the machine-readable version of the
  "absolute payloads" family; the idempotence contract test iterates it and fails if a new member
  is added without a case.
- `applyCommand` throws on an unregistered type rather than silently no-oping.
- Labels exist on every handler and are unconsumed, as planned.

**`GrabModeDragOperation`: heterogeneous drags are one compound command, not one multi-entity
command.** A grab can hold room vertices and lights simultaneously and there is no entity a
multi-entity payload could name; `{ kind: 'moduleEntity', ids }` in the plan's `DragTarget` only
covers the homogeneous case. `{ type: 'compound'; label; commands }` applies its members in order,
is serializable, is idempotent exactly when its members are (they all carry absolute targets), and
reuses the single-entity handlers unchanged. It is one preview, one dispatch, one history entry.
`UnifiedDragOperation` and multi-select `ObstacleVertexDragOperation` use the same construction,
and each collapses to the bare single command when only one entity moves — so a single-vertex drag
still dispatches `vertex.move`, not a compound of one.

**Things Phase 1b must know before touching the stores.**

- **Svelte's `writable` emits on every `set` of an object value even when the reference is
  unchanged** (`safe_not_equal` returns true for any object). Returning the old reference from
  `update` therefore does _not_ suppress the emission. `dispatch` reads, applies, compares with
  `valueEqual`, and **skips the write entirely** on a no-op. `reduceSession` must keep that
  property at the store boundary, not merely return the same `Session`.
- `valueEqual` (`src/commands/serializable.ts`) treats a key whose value is `undefined` as absent,
  so values that have been through `JSON.parse(JSON.stringify(...))` compare equal to their source.
- The serializability assertion is stricter than a bare round-trip: it also walks the payload and
  rejects non-plain data (`Map`, `Set`, class instances, functions, `NaN`/`Infinity`). A plain
  `JSON.stringify`-then-compare passes a `Map` — it stringifies to `{}` and compares equal to an
  empty object — which is exactly the mistake the assertion exists to catch. It runs inside
  `dispatch` behind a bare `if (import.meta.env.DEV)` and it **throws**.
- `commitInteraction()` sets `interaction` to idle _first_ and then dispatches, so the derived
  `roomStore` briefly recomputes against the pre-dispatch committed document. Svelte batches `$:`
  statements to the microtask flush, so no frame renders that intermediate value; making it one
  emission is a `reduceSession` action, which is 1b's job.
- Undo and redo clear `interaction` in `historyStore` today (two writable sets). 1b makes that
  atomic.
- `settingsStore` still owns `rafterConfig` and `displayPreferences` as separate writables and
  mirrors them into the document by dispatching on subscribe, guarded by `isLoadingFromSavedState`.
  That is a second source of truth and it survives 1a untouched; 1b or 3b should fold it in.
- `openDocument(doc)` is the pre-`Session` `document.open`: it clears the interaction and sets
  `committedRoom`. It **does** currently produce a history entry via the diff subscription, which
  matches pre-1a behavior (`roomStore.set` did too). The plan says `document.open` pushes no undo
  entry — 1b's acceptance criteria cover it, and it is a genuine behavior change to make there.
- `insertVertexOnWall` and `deleteVertex` still return a value to their caller (the inserted index,
  and success). They compute it from `committedRoom` _before_ dispatching. `vertex.insert` mints
  fresh wall ids inside the handler, so it is non-deterministic and non-idempotent by design.

**Deliberately deferred / not done.**

- `Interaction` has two variants only (`idle`, `commandPreview`). The plan's `drawing` and
  `measuring` variants are not introduced: drawing state still lives in `WallBuilder` and
  measuring in `MeasurementController`, and moving them is not needed to make drags previewable.
  `DragOrigin` is not modelled either — it is described in the plan as op-local and never read by
  the reducer, and each operation already keeps its captured origin privately.
- `IDragOperation.cancel()` is deleted as specified; `commit()` was also deleted and replaced by
  `finish()`, which only marks the operation inactive and releases captured state. Cancelling is
  now "discard the preview", which no longer needs an operation-side method at all.
- `DragManagerCallbacks` retains `onSetSnapGuides` (a visual side effect, not a write) and gains
  `onPreviewCommand` / `onCommitCommand` / `onCancelCommand`. Operations receive the narrower
  `DragOperationCallbacks` (`onSetSnapGuides` only). History pause/resume is gone from
  `historyStore` entirely, along with its tests.
- `pointercancel` and window `blur` are wired through a new `'cancel'` `InputEventType` in
  `InputManager`; `Canvas.svelte` cancels the drag (and leaves grab mode) on it.
- Dev-mode deep-freeze is **not** added — the plan assigns it to 1b.
- The pre-existing unused-`LightFixture` lint warning in `ViewerCanvas.svelte` was left alone.

**Tests.** `../../../tests/helpers/documents.ts` holds the fixtures (`squareRoom`, `rectWalls`,
`makeLight`, `makeDoor`, `makeObstacle`). New suites:
`../../../tests/unit/commands/applyCommand.test.ts` (pure command table with a coverage assertion against
`registeredCommandTypes`, JSON round-trip, move/set idempotence),
`../../../tests/unit/interactions/dragCommands.test.ts` (per-drag-kind pointer-sequence tables with snap and
axis-lock), `../../../tests/unit/stores/interactionPreview.test.ts` (preview live / commit exactly once /
untouched on cancel / origin drag emits nothing). `historyStore.test.ts` and `roomStore.test.ts`
were rewritten against the command API; the pause/resume block is gone. 311 tests pass.

#### Phase 1b

Commits: `30643ec` (implementation), `e738251` (store-boundary and settings tests).

**Where things live.**

- `src/types/session.ts` — `Session`, `History`/`HistoryEntry`, `CarriedState`, `Diagnostics`,
  `ModuleRuntimeStatus`, `LoadedDocument`, plus the selectors `undoLabel`, `redoLabel`,
  `canUndo(h)`, `canRedo(h)` and the constructors `createEmptySession`, `asLoadedDocument`.
- `src/types/selection.ts` — the `Selection` union and `NO_SELECTION`.
- `src/stores/reduceSession.ts` — `SessionAction`, `reduceSession`, `MAX_HISTORY = 50`.
- `src/stores/sessionStore.ts` — the store, and **every** narrow derived view.
- `src/stores/roomStore.ts` — now the verb layer only: re-exports `roomStore` /
  `committedDocument` / `interaction`, and holds the read helpers, the room-shaped derived
  views (`canPlaceLights`, `roomBounds`, …) and one thin command producer per call site.
- `src/utils/deepFreeze.ts` — the dev-only backstop.
- Both new type files are re-exported from `src/types/index.ts`.

**Deviations and additions.**

- **`committedRoom` is gone, not aliased.** The plan says "repoint `committedRoom` … export the
  latter as `committedDocument`"; keeping two names for one store is worse than moving the four
  read sites (`App.svelte`, `Toolbar.svelte`, `settingsStore`, tests). `roomStore` keeps its name
  and its live-preview meaning as planned, so no rendering or panel read site changed.
- **`DeepReadonly` is still not applied.** `Session`'s fields are `readonly` one level deep, and
  `EditorDocument` is mutable-typed exactly as it was in 1a. Introducing `DeepReadonly` would
  have forced a cast at every handler return and every renderer read in the same commit that
  replaces the store; the dev deep-freeze covers the same failure mode at runtime and the
  existing tests exercise it. **A later phase should add the type-level half** — 3a is the
  natural place, since it introduces `readModule`/`withModule` whose signatures the plan already
  writes in terms of `DeepReadonly`.
- **`sessionStore.current()` exists** and is not in the plan's sketch. `insertVertexOnWall` /
  `deleteVertex` (which compute a return value from the committed document before dispatching)
  and every `settingsStore` setter need a synchronous read that is not a subscription. It is
  documented as a smell; prefer the narrow stores.
- **`sessionStore.setRuntimeStatus(moduleId, status)`** wraps the plan's
  `diagnostics.setRuntimeStatus` action. Nothing calls it yet; phase 4 does.
- **`interaction` and `carried` are exported as narrow stores too**, beyond the five the plan
  names. `interaction` has read sites (tests, and phase 2/4 will want it); `carried` is there so
  3a has somewhere to read the quarantine map from.
- **The reference-equality guard is per subscriber, not a shared `derived`.** `svelte`'s
  `derived` calls `set` on every dependency emission and `writable.set` always notifies for
  object values, so a `derived` cannot suppress anything. Each narrow store is a hand-written
  `Readable` that holds its own `last` and declines to call `run`. `roomStore` additionally
  memoizes `previewDocument` on the session reference — otherwise it would allocate a fresh
  document per emission and the guard could never fire.
- **The 1a no-op guarantee is preserved in two halves.** `reduceSession` returns the **same
  session reference** for a value-equal result (and for `interaction.set` to an equal value,
  `selection.set` to an equal value, undo/redo on an empty stack, `interaction.commit` with
  nothing pending), and `sessionStore` **skips the write entirely** on `next === current`. Both
  halves are asserted: the reducer table asserts `toBe`, the store test asserts zero emissions.
- **`EditorDocument.modules`** is now a required field initialized to `{}`. Its type
  `ModuleSlices = Record<never, never>` is deliberately opaque — no index signature — so 3a can
  add `readModule`/`withModule` as the only doors without changing any call site. The legacy
  persistence adapter drops it, which is correct while it is always empty.
- **`document.open` takes a `LoadedDocument`**, as the plan specifies. Until 3a produces real
  ones, `asLoadedDocument(doc)` wraps a bare document with empty carried state and diagnostics;
  `openDocument(doc)` in `roomStore.ts` keeps its old signature so no call site changed.
- **Undo/redo history labels are now surfaced**: the toolbar tooltips read
  "Undo Move wall (Ctrl+Z)". That is the first consumer of the handler labels 1a added.
- **`historyStore.clear()` has no replacement and no caller.** `document.open` clears history, so
  the two `clear()` calls in `Toolbar.svelte` (new project, import) were deleted rather than
  ported. If some future path needs "keep the document, drop the history", add a
  `history.clear` action; nothing needs it today.

**`Session.selection` — what phase 2 must do.**

The field exists and holds the plan's `Selection` union verbatim (`none` / `wall` / `vertex` /
`obstacle` / `obstacleVertex` / `door` / `module`). `selection.set` is a reducer action,
`document.open` clears it to `{ kind: 'none' }`, `sessionStore.select()` and the narrow
`selection` store are wired, and the reducer table covers replace-not-merge. **Nothing reads or
writes it yet** — the six `appStore` writables are still the source of truth, exactly as the
brief required.

Phase 2 therefore has to:

- Migrate the six stores onto this field, deleting them and the manual cross-clears. The shims
  the plan describes should be `derived(selection, …)` over the field.
- **Decide where light selection goes.** There is no `light` variant, because lighting is a
  module: multi-select of fixtures becomes
  `{ kind: 'module', moduleId: 'lighting', type: 'fixture', payload: { ids } }`. Phase 2 lands
  before 3b, so it must either introduce that variant early (via `defineSelection('lighting',
'fixture', …)`, which needs no module system — just the two functions) or add a temporary
  `light` core variant and delete it in 3b. The first is cheaper; the union already has the
  extension point.
- Note the cardinality choice already baked in: `vertex` and `obstacleVertex` carry
  `indices: number[]` (multi-select), everything else carries a single `id`. That matches what
  `appStore` does today.
- `DragStartContext.selection` / `InteractionContext.selection` still take the old
  `SelectionState` bag (six sets/ids) from `types/interaction.ts`. Converting those is part of
  phase 2's call-site migration and is what the `Canvas.svelte` `current*` mirrors feed.

**`settingsStore` — folded in here, not deferred to 3b.**

`rafterConfig` and `displayPreferences` are no longer writables that dispatch on subscribe.
They are read-only `Readable`s projected from `committedDocument`, merging defaults on read
(and migrating the legacy `lightRadiusVisibility: 'never'`), with a `valueEqual` guard so a
geometry edit does not look like a settings change to every panel. Each setter
(`toggleRafters`, `setRafterOrientation`, `setRafterSpacing`, `updateRafterConfig`,
`toggleUnitFormat`, `toggleGridSnap`, `cycleLightRadiusVisibility`, `updateDisplayPreferences`)
is one dispatch. Consequences:

- **`initSettingsFromRoom()` is deleted**, along with the `isLoadingFromSavedState` re-entrancy
  flag. `App.svelte` and `ViewerPage.svelte` no longer call anything after `openDocument`.
- `Toolbar.svelte` and `Canvas.svelte` lost their local `displayPreferences.update(...)` /
  `rafterConfig.update(...)` closures and call the setters instead.
- Phase 3b moves `rafterConfig` into `modules.lighting`; only `readRafterConfig` in
  `settingsStore.ts` and the `lighting.setRafterConfig` handler have to follow it.
- **Pre-existing behavior kept, worth revisiting:** a display-preference toggle (grid snap, unit
  format, light-radius visibility) still produces an undo entry, because it is a document field
  and every document change is one entry. That was already true in 1a and before it; it is now
  visible in the tooltip as "Undo Change display preferences". If that is wrong, the fix is to
  move display preferences off the document — not to special-case history.

**Dev deep-freeze.**

`deepFreeze` runs on `loaded.document` in `document.open` and on every document `reduceSession`
produces, both behind a bare `if (import.meta.env.DEV)`. The helper retains no state (no
seen-set, no cache) so tree-shaking can drop it; it short-circuits on an already-frozen object,
which also makes re-freezing history snapshots free. It surfaced **no mutations** — the whole
suite (334 tests at that point, including the four integration suites that drive real handlers
and renderers) passed unchanged, and a sweep for in-place writes to document data found only
`LightManager`, which shallow-copies each fixture into its own map first. Preview documents are
_not_ frozen: they are produced outside the reducer by `previewDocument`.

**Not done / deferred.**

- `Interaction` still has two variants. The plan's `drawing` and `measuring` variants remain in
  `WallBuilder` and `MeasurementController`, as in 1a. `DragOrigin` is still op-local.
- No `DeepReadonly` (see above).
- The dev assertion that a command's _result_ is serializable, and the `defaultData()` freeze,
  are not applicable yet — there are no codecs. 3a adds both.
- `CarriedState.geometryFingerprint` is `''` and `quarantined` is always empty; 3a fills them.

**Tests.** `../../../tests/unit/stores/reduceSession.test.ts` is the pure table (no store, no Svelte, no
DOM) and covers the mixed label sequence, the 51-dispatch eviction plus 50 undos, open pushing
no entry while clearing interaction and selection, undo/redo clearing a pending drag including
one whose entity the restored snapshot no longer contains, and the dev freeze.
`../../../tests/unit/stores/sessionStore.test.ts` covers the store boundary: one action one emission,
zero emissions for a no-op, and each narrow store's guard. `historyStore.test.ts` became
`sessionHistory.test.ts` (same scenarios, `sessionStore.undo/redo`, `clear()` scenarios
rewritten as `openDocument`). `settingsStore.test.ts` is new. 352 tests pass.

#### Phase 2

Commits: `1dfc53c` (implementation), `682ccfc` (tests), `db7a4ef` (live-read fix).

**The fixture-selection decision: `defineSelection('lighting', 'fixture')`, not a temporary
core variant.**

`src/lighting/selection.ts` holds `fixtureSelection = defineSelection<{ ids: string[] }>('lighting',
'fixture', parse)` plus two conveniences, `getSelectedFixtureIds(selection)` and
`fixtureSelectionOf(ids)`. Chosen over a temporary `light` core variant because it leaves nothing
to unwind: `defineSelection` needs no module system, the panel key `lighting.fixture` is already
the string phase 4 will register the runtime panel under, and 3b/4 move the _file_ without
changing the value shape, the panel key, or any call site. A temporary core variant would have
had to be deleted from the union, the reducer's tests, every accessor, and the panel map — all
in 3b, the phase with the largest data change already.

Consequence worth knowing: **core interaction code imports `../lighting/selection`**
(`SelectionHandler`, `UnifiedDragOperation`, `GrabModeDragOperation`, `grabModeHelpers`,
`interactionUtils`, `Toolbar`, `Canvas`). That is a core→module import the boundary lint will
reject once these files live under `../../../src/floorplan`. It is deliberate and phase-4-shaped: those
call sites are the ones phase 4 replaces with a `ModuleView`/handler contribution anyway. If
phase 3a or 3b moves files into `../../../src/floorplan` before that, `getSelectedFixtureIds` has to
reach them through a config callback instead of an import.

**`multi` is a new variant on the plan's union — the plan's union could not express the
selection the app already had.**

```ts
| { kind: 'multi'; parts: readonly SelectionPart[] }
```

Box selection selects room vertices _and_ lighting fixtures together, and grab mode then moves
both — which is exactly why phase 1a introduced compound commands. No single-variant shape names
that, and dropping it would have been a functional regression. `SelectionPart` is
`Exclude<Selection, none | multi>`, so nesting is unrepresentable; `combineSelection(parts)` is
the only constructor (flattens, drops `none`, keeps the first part per panel key, and collapses
to `none` / the bare part when it can). Only `selectInBox` and `retainBoxCandidates` produce one.
Everything else replaces the whole value, so cross-clearing stays structural.

**API in `src/types/selection.ts` (names differing from the plan's sketch).**

- `SelectionKind<T>` gained `moduleId` and `type` alongside `panelKey`; the registry contract
  test in 3a/4 will want them.
- `defineSelection` **throws if `moduleId === 'core'`** — `CORE_MODULE_ID` is the namespace core
  selections use, so a core panel key is `core.wall`, `core.vertex`, `core.door`,
  `core.obstacle`, `core.obstacleVertex`. `panelKeyOf(part)` produces both forms, which is what
  lets one map serve core and module selections.
- `match` looks **inside a `multi`**, so a module can find its own payload in a heterogeneous
  selection without knowing the container exists.
- Accessors, all total and all reading through `multi`: `getSelectedWallId`, `getSelectedDoorId`,
  `getSelectedObstacleId`, `getSelectedVertexIndices`, `getSelectedObstacleVertexIndices`,
  `selectionParts`, `selectionPanelKeys`, `isEmptySelection`, `toggleMember`.
- **Cardinality is arrays, not `Set`s.** `Selection` is plain serializable data (asserted by a
  JSON round-trip test), which a `Set` is not. Renderers still take `Set`s; `Canvas` builds them.
- `getSelectedObstacleId` returns the obstacle of an `obstacleVertex` selection too. That
  reproduces today's behavior, where `selectObstacleVertex` set both stores, without a second
  field to keep in step. It is the one selection that lights up two accessors.

**Panel registry — `src/components/panelRegistry.ts`, ~45 lines with comments.**

`Map<string, ComponentType>` plus `registerPanel(s)` (throws on a duplicate key),
`resolvePanel(key)`, `panelsForSelection(selection)` and `clearPanels()` (test seam). `App.svelte`
registers in a `<script context="module">` block so it happens exactly once, and dispatches with:

```svelte
{#each panelsForSelection($selection) as panel (panel.key)}
  <svelte:component this={panel.component} />
{/each}
```

A `multi` selection resolves to several panels, which is how "vertices and fixtures both selected
shows both property panels" survived. Panels are now **mounted on demand** rather than rendered
always and self-hiding; each kept its internal `visible` guard, and `FloatingPanel` persists its
position by `persistenceKey`, so remounting is invisible.

**Exactly what phase 4 must repoint:** the `registerPanels({...})` literal in `App.svelte`'s module
script — replace it with a walk over each registered module runtime's `panels` record
(`ModuleRuntime.panels` is already specified as keyed by `SelectionKind.panelKey`), and move core
panel registration next to the core layers. The dispatch seam (`panelsForSelection` and the
`{#each}`) does not change, and neither do the key strings. The file itself probably moves to
`../../../src/app`; it lives under `components/` only because `../../../src/app` does not exist yet.

**Where things live.**

- `src/types/selection.ts` — the union, `defineSelection`, panel keys, accessors.
- `src/lighting/selection.ts` — `fixtureSelection` and its two helpers.
- `src/stores/selectionStore.ts` — the verb layer, re-exporting the narrow `selection` store so a
  component has one import for read and write.
- `src/components/panelRegistry.ts` — registration + dispatch.

**Deleted.** The six `appStore` writables (`selectedLightIds`, `selectedWallId`,
`selectedVertexIndices`, `selectedDoorId`, `selectedObstacleId`,
`selectedObstacleVertexIndices`), the two backward-compat deriveds (`selectedVertexIndex`,
`selectedLightId`), all eight `select*`/`clear*Selection` helpers, `SelectionState` from
`types/interaction.ts`, and `SelectionService` (its only job was toggling a `Set`; that is
`toggleMember` now). `appStore.ts` is down to modes, the active tool, and the camera-fit signal.
No derived shims survive — the migration was one commit rather than store-by-store, because
`SelectionState` threaded through the handler and drag-operation signatures and half-migrating it
would have meant two shapes in `InteractionContext` at once.

**Handler API changes phase 4 will meet.**

- `InteractionContext.selection` and `DragStartContext.selection` are now `Selection`.
- `SelectionHandlerCallbacks` lost `onClearLightSelection`, `onClearVertexSelection`,
  `onClearWallSelection`, `onClearDoorSelection`, `onClearObstacleSelection`,
  `onClearObstacleVertexSelection`, `getSelectedVertexIndices`, `getSelectedLightIds` and
  `getSelectedObstacleVertexIndices`. It gained `onRetainBoxCandidates` (shift+box-drag from empty
  space: keep the parts a box can extend, drop the rest). `SelectionActionCallbacks` in
  `selectionHelpers.ts` lost its three clear callbacks the same way.
- `SelectionHandler` reads the selection through `config.getSelection()` rather than through
  callbacks, so there is one source.

**The `Canvas.svelte` mirrors — converted together, as the plan's risk note required.**

There is one `$: currentSelection = $selection` and a single `$:` block deriving all six render
mirrors from it in one pass, so they cannot arrive out of step. **Input handlers do not read the
mirror**: `liveSelection()` (`get(selection)`) reads through the store synchronously, because
shift-click toggle-off detection selects and immediately re-reads, and `$:` assignments flush on
the microtask. That was the one non-mechanical bug in the migration — the deleted
`get(selectedVertexIndices)` callbacks had been reading synchronously.

**Behavior changes.**

- `setActiveTool` now clears the _whole_ selection. It previously left `selectedVertexIndices`
  alone — an inconsistency with `clearSelection`, not a feature.
- Shift-clicking a vertex still drops the fixture selection and vice versa (each `select*`
  replaces), matching the old `selectVertex`/`selectLight` which cleared each other explicitly.
  Only a box drag combines the two.

**Not done / deferred.**

- No `DeepReadonly` still (1b's note stands); `Selection` fields are plain arrays.
- `Interaction` still has two variants; `drawing`/`measuring` remain in `WallBuilder` and
  `MeasurementController`.
- Pre-existing `svelte-check` errors in `PropertyPanel.svelte`, `FloatingPanel.svelte`,
  `LightInfoBottomSheet.svelte` and `ViewerCanvas.svelte` were left alone (they are not in the
  `npm run` gate). Two genuine `currentRoom.walls` reads in `VertexPropertiesPanel.svelte` — dead
  since 1a nested the document — were fixed, since that file was being edited anyway.
- `ViewerCanvas.svelte` has its own `selectedViewerLight` store and was deliberately untouched:
  the viewer is a separate page with no editor session.

**Tests.** `../../../tests/unit/types/selection.test.ts` (round-trip `match(make(x))` including through a
`multi` and through JSON, non-matching module/type, hostile payload rejected, panel key derived
from the same pair, `core` namespace refused, structural cross-clearing, `combineSelection`
collapse and flattening), `../../../tests/unit/components/panelRegistry.test.ts` (dispatch by `panelKey`
for core _and_ module selections, several panels for a `multi`, two keys sharing one component,
unregistered kind is silent, duplicate key throws), `../../../tests/unit/stores/selectionStore.test.ts`
(the store exports exactly one `clear*`; every `select*` replaces every other kind; shift toggle;
obstacle-vertex fallback; box selection; tool switch and `open` clearing; a repeat selection emits
nothing). 396 tests pass; the 352 inherited from 1b were not changed except for the two that
constructed a `SelectionState` bag.

#### Phase 3a

Commits: `dc5dd84` (infrastructure + codecs + fixtures), `5c23096` (fixture and contract tests),
`aa7b1a6` (dev backstops).

**No live data moved.** `EditorDocument.lights` / `.rafterConfig` are untouched at the document
root, the legacy `light.*` core commands still exist, `legacyDocumentAdapter.ts` still exists, and
no entry point calls `decodeDocument`. Everything below is built, tested, and unused by production
code — except the eager barrel, which `main.ts` imports so the registry is populated.

**Where things live** (the `../../../src/floorplan` move is still phase 4's; core files sit where their
neighbours already are).

| File                                        | What                                                                                                                                                                                                                   |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/types/deepReadonly.ts`                 | `DeepReadonly<T>`, `asMutable<T>`                                                                                                                                                                                      |
| `src/types/module.ts`                       | `ModuleBlob`, `DecodeResult`, `ModuleCodec`, `readModule`/`withModule`/`hasModuleSlice`/`buildModuleSlices`/`moduleSliceIds`, `ModuleDataStatus`/`moduleDataStatus`, `RegisteredCommand`/`CommandKind`/`defineCommand` |
| `src/types/moduleRegistry.ts`               | `ModuleDefinition`, `registerModule`, `registeredCodecs`, `codecFor`, `registeredModuleCommands`, `moduleCommandHandler`, `clearModuleRegistry`                                                                        |
| `src/types/command.ts`                      | `ModuleCommandEnvelope`, `EditorCommand = CoreCommand \| ModuleCommandEnvelope`, `isModuleCommand`                                                                                                                     |
| `src/persistence/envelope.ts`               | `DocumentEnvelopeV3`, `ENVELOPE_VERSION`, `toEnvelopeV3`                                                                                                                                                               |
| `src/persistence/documentCodec.ts`          | `decodeDocument`, `encodeDocument`, `EncodeTarget`, `geometryFingerprint`                                                                                                                                              |
| `src/persistence/geometryValidation.ts`     | `validateGeometry`, `validateSpace`, `validateDisplayPreferences`                                                                                                                                                      |
| `src/persistence/ValidationError.ts`        | moved out of `jsonImport.ts` (which now re-exports it)                                                                                                                                                                 |
| `../../../src/modules/lighting/codec.ts`    | `LightingData`, `lightingCodec`, `defaultLightingData`, `referencedDefinitions`, `resolveDefinition`, `isBuiltinDefinitionId`                                                                                          |
| `../../../src/modules/lighting/commands.ts` | eight `CommandKind`s + `lightingCommands`                                                                                                                                                                              |
| `../../../src/modules/codecs.ts`            | the eager barrel; `installModules()`, called at import time                                                                                                                                                            |
| `../../../tests/fixtures`                   | seven JSON fixtures + `load.ts` + a README table                                                                                                                                                                       |

**The registry is core-owned and the barrel pushes into it.** The plan says "the registry in
`modules/codecs.ts`", but `documentCodec` has to read it and `floorplan/**` may not import
`modules/**`. So `src/types/moduleRegistry.ts` holds the table, and `modules/codecs.ts` is the
eager barrel that statically imports each module's `codec.ts` + `commands.ts` and calls
`registerModule`. It registers at module-evaluation time, so importing it anywhere in the entry
graph is enough; `main.ts` does. **This is deliberate and phase 4 should keep it** — it is what
lets `documentCodec` stay boundary-clean. Each definition is a module-level constant, so
`installModules()` is idempotent (re-registering the identical object is a no-op, a _different_
module under a taken id throws).

**`LightingData` as built** — exactly the plan's shape:

```ts
export interface LightingData {
  fixtures: LightFixture[];
  rafterConfig: RafterConfig; // always present; defaults merged on decode
  deadZone: DeadZoneConfig; // always present; defaults merged on decode
  spacing: SpacingConfig; // always present; defaults merged on decode
  definitions: LightDefinition[]; // closure of NON-BUILTIN definitions referenced by fixtures
}
```

`schemaVersion` is 1. Decisions inside it worth knowing:

- **`definitions` is normalized to the closure on every decode and on every fixture command.**
  `referencedDefinitions(fixtures, definitions)` drops any definition no fixture references, so
  decode → encode → decode is stable and prune-on-save can actually reach the default. "Non-builtin"
  means "not an id in `DEFAULT_LIGHT_DEFINITIONS`", not the `custom-` prefix.
- **Optional sub-configs merge onto a fresh default rather than failing**, field by field. A v1/v2
  document has no `deadZone` or `spacing` at all, and quarantining every legacy document would have
  been absurd. `fixtures` and `definitions` are validated strictly — a bad one is `invalid`.
- **`v < 1` is `invalid`, not `unsupported`.** `toEnvelopeV3` coerces a structurally broken module
  entry to `{ v: 0, data: <whatever was there> }`, which is how a non-`{v,data}` entry gets
  preserved rather than dropped.
- `resolveDefinition(data, id, library)` prefers the document's copy and falls back to the library.
  It is pure and takes the library as a parameter — 3b wires the picker store in at the call site.
- `compactForShare` keeps fixtures, `rafterConfig` and the definition closure; resets `deadZone`
  and `spacing` to defaults (authoring state, not viewing state).

**The codec/command API as built.** `ModuleCodec` and `DecodeResult` are verbatim from the plan.
Additions and shape changes:

- `defineCommand(codec, verb, spec, options?)` takes a fourth argument, `{ absolute?: boolean }`,
  which is the module-side equivalent of `MOVE_AND_SET_COMMAND_TYPES`. The contract test asserts
  applying an `absolute` command twice equals applying it once.
- `CommandKind<P>` extends a non-generic `RegisteredCommand` (`type`, `moduleId`, `verb`,
  `absolute`, `handler`). `CommandKind<P>` is invariant in `P`, so a heterogeneous registry needs
  the payload type _erased_, not widened to `unknown`. `ModuleDefinition.commands` is
  `readonly RegisteredCommand[]`.
- `EditorCommand` is now `CoreCommand | ModuleCommandEnvelope`. `CommandType` narrowed to
  `CoreCommand['type']`, so the exhaustive core handler table and `registeredCommandTypes` are
  unchanged and every existing test kept working. `applyCommand`/`commandLabel` branch on
  `isModuleCommand` and fall through to `moduleCommandHandler(type)`.
- **`withModule` on an absent slice is a no-op returning the same document reference**, plus a dev
  `console.warn`. That is how "dispatching a module command whose slice is quarantined is a no-op
  and a dev assert" is implemented. `readModule` on an absent slice returns a _fresh_
  `codec.defaultData()`.
- Registration throws on: duplicate module id, an id containing `.`, `schemaVersion < 1`, a command
  whose `moduleId` disagrees with the codec, a command type not namespaced with the module id, and
  a duplicate command type. **It does not check module-vs-core command-type collisions** — that
  would need `moduleRegistry` to import `commands/registry.ts`, which imports it back. The contract
  test asserts it instead.

**`DeepReadonly` — introduced, deliberately not retrofitted.**

```ts
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends ReadonlyArray<infer U>
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;
```

It is used on the _new_ API only: `readModule`, `withModule`, `hasModuleSlice`, `moduleSliceIds`,
`ModuleCommandSpec.apply`, `encodeDocument`, `geometryFingerprint`. `Session` and `EditorDocument`
still carry bare `readonly` fields as they did after 1b. This works without churn because a mutable
`T` is assignable to `DeepReadonly<T>` — only the reverse needs a cast, and those are confined to
`withModule` and the `defineCommand` wrapper. `asMutable<T>` exists for that and is deliberately
ugly. **Widening `Session.document` to `DeepReadonly<EditorDocument>` is still open**; it is now a
mechanical, separately-reviewable change rather than a blocker.

**Fixtures live in `../../../tests/fixtures`** (`legacy-flat.json`, `envelope-v1.json`, `envelope-v2.json`,
`envelope-v2-custom-definition.json`, `envelope-v3-future-module.json`,
`envelope-v3-corrupt-blob.json`, `envelope-v3-unknown-module.json`), read via
`loadFixture(name)` in `../../../tests/fixtures/load.ts`, which re-parses on every call so no test can hand
another a mutated object. `../../../tests/fixtures/README.md` says what each one proves.

An eighth shape was added beyond the plan's list: **`legacy-flat.json`, the unversioned `RoomState`**
that local storage has always written. The plan calls local storage "the weakest and the most common
source of pre-migration documents", and it has no `version` field at all, so it needed its own
fixture. Its door has no `swingSide`, which exercises that migration.

**v1 and v2 read identically.** The number versions the _light-definition envelope_, not the
document schema, and the existing `processImportData` already treated them the same. `envelope-v1`
is simply the older-looking document (no doors, obstacles, rafters or display preferences).

**Failure policy and merge precedence, as implemented.** Table rows all hold. Notes:

- Only `validateGeometry` / `validateSpace` throw (`ValidationError`). A legacy document whose
  `lights` array is broken now **quarantines** where `jsonImport` used to throw — a deliberate
  behavior change under invariant 8, and one 3b inherits when it deletes `jsonImport`'s validator.
- `unknownModule` produces no warning. `unsupported` and `invalid` each produce one.
- `quarantineFlags` is written only for `file`/`local`, only when something is quarantined, and the
  drift bit is computed once from `geometryFingerprint(document.geometry) !== carried.geometryFingerprint`.
- `geometryFingerprint` is FNV-1a over a key-sorted stringification of `geometry` (8 hex chars). It
  is a change detector, not a digest.
- Share: quarantined blobs and every non-target live slice are omitted; `encodeDocument` **throws**
  if the share target is itself quarantined.
- Live-vs-quarantined for the same id throws in dev (it is a decode bug), and live wins in prod.

**Dev backstops added here** (both behind a bare `if (import.meta.env.DEV)`):

- `withModule` runs `assertPlainData` on the slice it writes and deep-freezes it. `assertPlainData`
  is now exported from `src/commands/serializable.ts`.
- `decodeDocument` deep-freezes both the document and the carried state it returns.

**Phase 2's core→module import note.** Nothing in 3a makes it better or worse: no files moved, and
`../../../src/floorplan` still does not exist. It is, however, now clear that `documentCodec` must _not_
import `modules/codecs.ts` — the push-not-pull registry above is the pattern the rest of core should
follow, and `src/lighting/selection.ts`'s importers are the remaining exception for phase 4.

**Deliberately not done.**

- No entry point routes through `documentCodec` (3b). `jsonImport`, `jsonExport`, `localStorage` and
  `shareUrl` are byte-for-byte unchanged except for the `ValidationError` move.
- `decodeDocument` sets `document.lights = []`. It does **not** mirror the lighting slice back to
  the legacy root fields — wiring it up before 3b deletes those fields would lose fixtures. See the
  3b checklist below.
- No `ModuleRuntime`, `ModuleView`, `ActivationScope`, panels, tools or layers (phase 4).
- `Interaction` still has two variants; `drawing`/`measuring` still live in `WallBuilder` and
  `MeasurementController`.
- The `light.*` / `lighting.setRafterConfig` **core** commands still exist and are still what the UI
  dispatches. The new `lighting.*` module commands are registered but unreachable.

**Exactly what phase 3b must do.**

1. Delete `lights` and `rafterConfig` from `EditorDocument` (`src/types/document.ts`) and from
   `createEmptyDocument`. Delete the `lights: []` line in `decodeDocument` and its comment. Fix
   `../../../tests/helpers/documents.ts` (`makeDocument` takes `lights`) to seed
   `modules: buildModuleSlices({ lighting: { ...defaultLightingData(), fixtures } })`.
2. Delete the `light.*` and `lighting.setRafterConfig` core commands (`src/commands/lightCommands.ts`,
   the entries in `registry.ts`, the union members in `types/command.ts`, and their entries in
   `MOVE_AND_SET_COMMAND_TYPES`), and repoint every producer at
   `../../../src/modules/lighting/commands.ts`. Producers: `roomStore.ts`'s thin command helpers,
   `settingsStore.ts` (`readRafterConfig` + the four rafter setters), `UnifiedDragOperation`,
   `GrabModeDragOperation`, and the light property panels. Note `addFixture`'s payload carries an
   optional `definition` — pass the picker's definition when placing a fixture from the library, or
   the closure will not be closed.
3. Repoint every reader of `$roomStore.lights` / `.rafterConfig` at
   `readModule(doc, lightingCodec).fixtures` / `.rafterConfig`. A narrow guarded `Readable` in
   `sessionStore.ts` (follow the existing hand-written pattern — **not** Svelte `derived`) is the
   cheap way to keep component code unchanged in shape.
4. Route persistence through the codec, deleting `legacyDocumentAdapter.ts`:
   - `loadFromLocalStorage` → `decodeDocument(JSON.parse(raw))`, returning `LoadedDocument`;
     `saveToLocalStorage` → `JSON.stringify(encodeDocument(doc, carried, { kind: 'local' }))`.
   - `importFromString` / `importFromJSON` → `decodeDocument(JSON.parse(text))`. Delete
     `validateRoomState` and everything under it in `jsonImport.ts`; keep `ValidationError`
     re-exported or update the importers.
   - `jsonExport.createExportData` → `encodeDocument(doc, carried, { kind: 'file' })`.
   - `shareUrl.createSharePayload` → `encodeDocument(doc, carried, { kind: 'share', moduleId })`;
     `decodeShareData` → `decodeDocument`. The module-in-the-path URL change is phase 5.
   - Every load path ends in `sessionStore.open(loaded)` with the real `LoadedDocument`;
     `asLoadedDocument` in `types/session.ts` should end up with no callers but
     `createEmptySession`.
   - **`encodeDocument` needs `carried`**, which lives on the session. `saveNow`, `setupAutoSave`
     and the export/share callers currently take a bare document — they must take the session or a
     `(document, carried)` pair. `sessionStore.current()` is the escape hatch if a call site cannot
     be threaded.
5. Demote `lightDefinitionsStore` to a picker library: delete `mergeLightDefinitions` and its call
   in `processImportData`, and replace it with an explicit post-`open` adoption step that dispatches
   `lighting.definitions.set` (or leaves the document's definitions alone and offers to add unknown
   incoming ones to the local library). `resolveDefinition` from the codec, with
   `get(lightDefinitions)` as the `library` argument, is what every photometry read should call.
6. Re-run `../../../tests/unit/persistence/documentCodec.test.ts` unchanged — it is the regression gate — and
   add the 3b acceptance case: load → visit a mode → save is value-identical, and a slice equal to
   its default is pruned.

#### Phase 3b

Commits: `ef5e871` (the data move), `874a1d8` (tests), `3e0d291` (share failure handling, picker-aware
placement, panel reads).

**The document has no domain fields at its root any more.** `EditorDocument` is
`geometry + space + displayPreferences? + modules`. `lights` and `rafterConfig` are deleted, and so
are `RoomState`, `DEFAULT_ROOM_STATE`, `LightChanges`, `src/persistence/legacyDocumentAdapter.ts`,
`src/commands/lightCommands.ts`, `src/stores/deadZoneStore.ts` and `src/stores/spacingStore.ts`.

**`createEmptyDocument()` normalizes module slices, and that is new machinery the plan does not
mention.** An absent slice is how a _quarantined_ module is represented — `withModule` on one is a
no-op — so a document nothing decoded (a new project, a hand-built test fixture) must still carry a
materialized default or every `lighting.*` command it dispatches would silently do nothing.
`defaultModuleSlices()` in `src/types/moduleRegistry.ts` builds `{ id: codec.defaultData() }` for
every installed module and `createEmptyDocument()` calls it. Consequences:

- **Registration must happen before any document is built.** `main.ts` already imports
  `./modules/codecs` first; `../../../tests/setup.ts` (new, wired via `setupFiles` in `../../../vite.config.ts`) does
  the same for the suite. A test that constructs a document without it gets a sliceless document and
  no-op commands — a silent failure, so the setup file is load-bearing.
- `src/types/document.ts` now imports `./moduleRegistry`. That is core→core and there is no runtime
  cycle (`module.ts`'s import of `document.ts` is type-only), but it is worth knowing before the
  `../../../src/floorplan` move.

**The lighting write path, end to end.**

1. A producer calls a verb in `src/stores/lightingStore.ts` (`addLight`, `moveLight`,
   `applyDefinitionToFixtures`, `removeLights`, `toggleRafters`, `updateRafterConfig`,
   `setRafterOrientation`, `setRafterSpacing`, `toggleDeadZones`, `toggleSpacingWarnings`).
2. That verb builds a registered `lighting.*` command with `CommandKind.make(...)` and calls
   `sessionStore.dispatch` exactly once. Several fixtures at once collapse to a `compound`, so it is
   still one history entry.
3. `applyCommand` resolves the handler through `moduleCommandHandler`, and `defineCommand`'s wrapper
   applies it through `withModule`.
4. Drags are unchanged in shape: `UnifiedDragOperation` and `GrabModeDragOperation` now return
   `moveFixture.make({ fixtureId, position })` where they returned `{ type: 'light.move', ... }`, so
   a fixture drag is a candidate command like any other.

**Reads.** `src/stores/documentSlice.ts` (new, ~30 lines) is the shared guarded projection helper —
the hand-written `Readable` pattern from `sessionStore.ts`, parameterized by source store and
equality. `lightingStore.ts` exposes `lightingData` / `fixtures` (live, off `roomStore`, so a drag
previews) and `committedLightingData` / `rafterConfig` / `deadZoneConfig` / `spacingConfig`
(committed, so a panel does not flicker mid-gesture). `spacingWarnings` moved here too. `readModule`
returns the stored slice by reference, so a plain reference guard is enough; `settingsStore`'s
`displayPreferences` still needs `valueEqual` because it merges defaults on read.

**Deviations from the plan's step list.**

- **The narrow lighting stores are in `src/stores/lightingStore.ts`, not in `sessionStore.ts`** as
  step 3 suggested. Putting them in `sessionStore.ts` would have made core import
  `modules/lighting/codec.ts`, which is exactly the boundary phase 4 has to enforce. This file is
  lighting's and phase 4 moves it wholesale.
- **`rafterConfig` left `settingsStore.ts` entirely** rather than "only `readRafterConfig` follows
  it", for the same reason. `settingsStore.ts` is now display preferences only, which is genuinely
  core. `deadZoneStore.ts` and `spacingStore.ts` were deleted rather than repointed — their configs
  are document data now, so a writable store for them was a second source of truth.
- **`InteractionContext` gained a `fixtures: LightFixture[]` field.** `SelectionHandler` and
  `BoxSelectionHandler` read `context.document.lights`; core handlers may not reach into a module
  slice, so `Canvas.svelte` reads it out and passes it in. This is a seam, not a home — phase 4
  replaces it with a `ModuleView` handed to lighting's own handlers.
- **`SaveInput = { document, carried }`** (`src/types/session.ts`) and the `saveInput` narrow store
  (`sessionStore.ts`, memoized on both parts) are how `carried` gets threaded. `saveNow`,
  `setupAutoSave`, `exportToJSON`, `getJSONString` and `generateShareUrl` all take one, so a save
  path that forgets the quarantined blobs does not compile. This is the plan's "(document, carried)
  pair" made a type.
- **`generateShareUrl(input, moduleId)` takes the module id as a parameter**; the callers pass
  `LIGHTING_MODULE_ID`. Core names no module, and phase 5 puts the same id in the URL path. The URL
  itself is still `#/viewer?d=...`, unchanged.
- **`ExportData` is gone from the write path.** `jsonExport.createExportData` returns a
  `DocumentEnvelopeV3` now. `toEnvelopeV3` still _reads_ `{ version: 1 | 2, roomState,
lightDefinitions }`, permanently.
- **Both share buttons now catch.** `encodeDocument` throws when the share target is quarantined;
  the handlers alert and return rather than rejecting an async click handler.
- **`applyDefinitionToFixtures` orders its compound deliberately.** `definitions.set` normalizes
  against the fixtures as they are _after_ the `fixture.set`s, so the adopted definition command must
  come last or it is pruned as unreferenced. Same reason `addFixture` carries an optional
  `definition`.

**The global definitions store and the adoption step.**

`src/stores/lightDefinitionsStore.ts` is the fixture **picker library** and nothing else: its own
`lumen2d_light_definitions` key, no document involvement. `mergeLightDefinitions` is deleted along
with the merge-on-decode side effect in `processImportData`, so decode is pure.

- `adoptIncomingDefinitions(document)` in `lightingStore.ts` is the explicit post-`open` step. It
  adds only the ids the library lacks, so a local `custom-abc` is never overwritten by a stranger's.
  Called immediately after `openLoaded` at all four load sites (`App.svelte`, `Toolbar.svelte`
  import, `ViewerPage.svelte` share link and file open).
- `pickerDefinitions` is what the UI offers: the library with each id resolved through
  `resolveDefinition` (**the document's copy wins**), plus any document-only definition. Every
  photometry read goes through it — `LightToolPanel`, `LightPropertiesPanel`, and `LightManager`,
  which is now constructed with `(id) => get(pickerDefinitions).find(...)` instead of the library's
  `getDefinitionById`. That is the fix for a share link rendering the sender's fixtures with the
  recipient's photometry.

**Behaviour changes worth knowing.**

- Toggling dead zones or spacing warnings is now a document edit, so it is undoable and marks the
  project dirty. Same for rafter visibility, which was already true after 1b. If that is wrong the
  fix is to move those settings off the document, not to special-case history.
- A file or share link whose lighting blob is undecodable quarantines instead of throwing (inherited
  from 3a; now reachable from the UI). Geometry still loads and stays editable.
- `Diagnostics.warnings` is populated on every real load and **still has no UI**. Deferred — the
  natural home is the Studio shell in phase 4/5.

**Deliberately not done.** No `ModuleRuntime` / `ModuleView` / activation scope; nothing moved to
`../../../src/floorplan` or `../../../src/modules/lighting` beyond what 3a put there; `EditorRenderer` still names
each renderer; `Toolbar`/`Canvas` are still hand-wired; the boundary lint is still inert; share URLs
are still `#/viewer`. `Interaction` still has two variants. `Session.document` is still
`EditorDocument`, not `DeepReadonly<EditorDocument>`.

**What phase 4 must know.**

- **Files that are lighting's and must move under `../../../src/modules/lighting`:** `src/lighting/*`
  (`LightManager`, `LightCalculator`, `LightingStatsCalculator`, `SpacingAnalyzer`, `LightIcon`,
  `IESParser`, `constants.ts`, `selection.ts`), `src/stores/lightingStore.ts`,
  `src/stores/lightDefinitionsStore.ts`, `src/stores/lightingStatsStore.ts`,
  `src/rendering/{LightRenderer,HeatmapRenderer,ShadowRenderer,DeadZoneRenderer,SpacingWarningRenderer,RafterOverlay,BaseLightingRenderer}.ts`,
  `src/interactions/handlers/LightPlacementHandler.ts`, and the light panels under
  `src/components/`. `codec.ts` and `commands.ts` are already there.
- **The core→module imports the boundary lint will reject the moment core moves to
  `../../../src/floorplan`**, all of them deliberate and all of them phase 4's to remove:
  - `src/lighting/selection.ts` ← `SelectionHandler`, `UnifiedDragOperation`,
    `GrabModeDragOperation`, `grabModeHelpers`, `interactionUtils`, `Toolbar`, `Canvas` (phase 2's
    note, unchanged).
  - `../../../src/modules/lighting/commands.ts` ← `UnifiedDragOperation`, `GrabModeDragOperation` (new in
    3b, for `moveFixture.make`).
  - `../../../src/modules/lighting/codec.ts` ← `src/stores/lightingStore.ts`, `Toolbar.svelte`,
    `ViewerToolbar.svelte` (for `LIGHTING_MODULE_ID`).
  - `InteractionContext.fixtures` is the shape of the problem: core interaction code needs
    fixtures for hit-testing, selection origin and box selection. The `ModuleView` + module-owned
    handlers contract is what removes all of the above at once; a config callback is the cheap
    fallback if a file has to move early.
- **`src/modules/*/codec.ts` and `commands.ts` may not import `three` or `*.svelte`** — still true,
  and `lightingStore.ts` imports `svelte/store`, so it belongs in the module's _runtime_ half, not
  beside the codec, or the lint rule has to distinguish them.
- **Keep the push-not-pull registry.** `documentCodec` reads `types/moduleRegistry.ts`;
  `modules/codecs.ts` pushes into it at import time. `types/document.ts` now reads it too.
- **`asLoadedDocument` has two callers left**: `openDocument`/`resetRoom` in `roomStore.ts` (a new
  project, which nothing decodes) and the settings tests. That is correct, not a leftover.
- **`saveInput`, not `committedDocument`, is what any new save path subscribes to.**

**Tests.** 477 pass (435 inherited plus the two new suites; the 454 of 3a lost the five legacy
`light.*` cases from `applyCommand.test.ts`, the `validateRoomState` block that no longer exists, and
the rafter half of `settingsStore.test.ts` — all replaced by module-command and lighting-store
coverage). New: `../../../tests/unit/persistence/entryPoints.test.ts` runs all seven phase-3a fixtures through
`importFromString` and `loadFromLocalStorage`, asserts load → visit a mode → save is value-identical
with no history entry, asserts a default slice is pruned, and covers share generate → decode
including the custom-definition closure and the quarantined-target refusal;
`../../../tests/unit/stores/lightingStore.test.ts` covers live-vs-committed projections, no-emission on an
unrelated edit, each setter as one undoable command, and the definition closure following its
fixtures. `../../../tests/helpers/documents.ts` gained `lightsOf` / `lightingOf` and seeds the lighting slice.
`documentCodec.test.ts` is unchanged and still green.

`npm run test:run`, `npm run type-check`, `npm run lint`, `npm run build` and `npx prettier --check .`
all pass. `npx svelte-check` is down to four pre-existing errors, none in the lighting path.

#### Phase 4

Commits: `f051356` (the move), `1a6e4c3` (runtime manifest, activation, entity seam),
`0c4ae72` (the viewer), `1befd1f` (tests + the diagnostics banner), `166eb8d` (tool ids),
`e15e681` (the `invalidate` fix).

**The directory layout, as built.**

```
src/
  main.ts                     entry; imports ./modules/codecs first, then mounts app/App.svelte
  floorplan/                  domain-agnostic core
    commands/ constants/ controllers/ core/ geometry/ interactions/ persistence/
    rendering/ services/ stores/ types/ utils/
    ui/                       Canvas.svelte, the core property panels, DoorToolPanel,
                              FloatingPanel, LengthInput, panelRegistry.ts, coreTools.ts
  modules/
    codecs.ts                 eager barrel; also carries each module's `loadRuntime`
    lighting/
      codec.ts commands.ts    EAGER
      entities.ts selection.ts constants.ts types.ts   EAGER-safe (no three, no svelte)
      runtime.ts layers.ts    LAZY
      store.ts definitionsStore.ts statsStore.ts
      LightManager.ts LightCalculator.ts LightingStatsCalculator.ts SpacingAnalyzer.ts
      LightIcon.ts IESParser.ts LightPlacementHandler.ts
      rendering/              the six lighting renderers + shaders/
      ui/                     the light panels and RafterControls
  app/                        Studio shell
    App.svelte Toolbar.svelte StatusBar.svelte PropertyPanel.svelte
    DiagnosticsBanner.svelte routerStore.ts viewer/
```

Placement decisions worth knowing:

- **`panelRegistry.ts` is in `floorplan/ui/`, not `app/`** (phase 2 guessed `app/`). The
  activation registry registers and unregisters a module's panels, and `floorplan/stores/` may
  not import `app/`. The dispatch seam and the key strings are unchanged, exactly as phase 2
  promised.
- **The viewer is `app/viewer/`.** It is lighting-heavy (heatmap, shadows, a light info sheet)
  but it is a page, and `app/**` may import anything, so nothing had to be generalized.
- **`PropertyPanel` and `StatusBar` are `app/`** — both read a module's data (fixture count, the
  active tool's label). Keeping them in `floorplan/ui/` would have needed another seam for no
  gain.
- `src/types/lighting.ts` became `../../../src/modules/lighting/types.ts`, which is where `RafterConfig`
  and `DEFAULT_RAFTER_CONFIG` moved too. `floorplan/types/index.ts` no longer re-exports any of
  it, so ~20 files had their barrel import split in two.

**Contract changes, and why.** The plan says to change the contract if it does not fit lighting.
Four things changed.

1. **`ModuleView` gained `displayPreferences` and `viewMode`.**
   `LightRenderer` needs `displayPreferences.lightRadiusVisibility`; the unit format drives
   dimension labels. Both are document data core owns, so the view is the right place. `viewMode`
   is app presentation state and is there so **a layer decides its own visibility** — that is
   what let `EditorRenderer` drop `setLightsVisible` and `updateViewMode`, which were the last
   lighting-shaped methods on it. The alternative (a module subscribing to `appStore`) violates
   invariant 6.
2. **`EntityDescriptor` / `EntityAccess` — the replacement for `InteractionContext.fixtures`.**
   The plan's `ModuleView` + module-owned handlers is not enough on its own: core's box
   selection, grab mode, unified drag, snapping, measurement and the Delete key all operate on
   room vertices **and** the module's entities in one gesture. Those are core handlers and they
   stay core. So a module declares
   ```ts
   interface EntityDescriptor<T> {
     selection: SelectionKind<{ ids: string[] }>; // supplies moduleId, type, panelKey
     hitTolerance: number;
     list(view: ModuleView<T>): readonly ModuleEntity[]; // { id, position }
     moveCommand(id, position): EditorCommand; // absolute
     removeCommand(ids): EditorCommand | null; // one command, one history entry
   }
   ```
   and the registry binds it to the live view as an `EntityAccess`
   (`list/find/at/inBox/selectedIds/selectionOf/moveCommand/removeCommand`). `NO_ENTITIES` is a
   total no-module implementation, so core never branches on "is a module active". This is what
   removed **every** core→module import phase 3b listed, in one go. Flooring's transitions and
   layout origin fit it; planks do not, and should not — they are derived output, not selectable
   point entities, and phase 6 will need a different seam for them (`SceneLayer.inputs?`).
3. **`ToolDescriptor` carries its own SVG icon markup and an optional `key`.** A tool the toolbar
   cannot draw is a tool core has to know about. Core's three toolbar tools use the identical
   descriptor (`floorplan/ui/coreTools.ts`), so `Toolbar.svelte` is one `{#each $toolbarTools}`.
   `enabled?(view)` is re-evaluated against the live view.
4. **`Tool` is `string`, not a closed union.** `'light'` was a member of a core type. Core owns
   `select`/`draw`/`door`/`obstacle` (`CORE_TOOL_*` in `floorplan/types/state.ts`) and everything
   else is `${moduleId}.${verb}`; lighting's is `lighting.place`. `InteractionContext` lost
   `isPlacingLights` and gained `activeTool` plus `isModuleToolActive` — core knows _that_ a
   module tool owns the pointer, never which.

Smaller shape changes: `SnapController.snapToLights` → `snapToEntities(pos, ModuleEntity[], id)`;
`MeasurementController`'s `light` source/target variant → `entity`
(`startFromEntity`, `setTargetEntity`, `isFromEntity`, `sourceEntityId`);
`selectionStore.selectFixture/setFixtureSelection` → `selectEntity/setEntitySelection(entities, …)`
and `selectInBox`/`retainBoxCandidates` take the `EntityAccess` as their first argument;
`getSelectionOriginFromRoomState` → `getSelectionOriginFromDocument`;
`RoomStateWithLights` → `RoomStateWithEntities` (`getEntities`, not `getLights`);
`LIGHT_HIT_TOLERANCE_FT` moved to `modules/lighting/constants.ts`.

**What the activation scope actually owns.** `floorplan/stores/moduleActivation.ts`.

- Scene layers (`dispose()` each), input handlers, panel registrations, shortcut bindings, the
  `AbortSignal`, and anything a module hands it in `onActivate`. Lighting registers a
  `pickerDefinitions` subscription there — the "derived subscription" the plan warns about.
- `Scope.own(fn)` after disposal **runs `fn` immediately** rather than retaining it.
- `dispose()` aborts the signal _first_, then runs disposers in reverse order.
- The registry is the only caller of `dispose`. `EditorRenderer.dispose()` disposes core layers
  only; `setModuleLayers` is a pointer swap.
- `sessionStore.beforeOpen(hook)` is new: `open` runs its hooks synchronously before the reducer
  action, and activation registers one that deactivates and schedules a re-activation. No layer
  ever sees two unrelated documents.
- **Registration validation lives in `moduleRegistry.ts`**, split in two because runtimes are
  lazy: `registerModule` (eager) checks module id, label, schema version and command namespacing
  as before; `validateRuntime(runtime)` (on first resolution) checks tool namespacing, duplicate
  tool ids, panel keys, shortcut bindings and that contributed entities are selected under the
  module's own id; `claimLayerIds(moduleId, ids)` runs at activation because layer ids are only
  knowable once a scene exists. Core claims its own strings with `claimCoreLayerIds` /
  `claimCorePanelKeys`.
- **Claims are permanent for the session, not released on deactivate.** Only one module is active
  at a time, so releasing them would make a module-vs-module conflict undetectable. `CORE_RESERVED_SHORTCUTS`
  in `floorplan/types/moduleRuntime.ts` encodes "core wins"; a test asserts it matches the
  bindings `createDefaultKeyboardShortcuts` actually produces. **Tool keys are deliberately not
  in the shortcut table** — they resolve core-first through the tool list, so `L` can select
  lighting's tool while core keeps `L` for "type a wall length" while drawing.

**`ModuleRuntime` as built** (`floorplan/types/moduleRuntime.ts`): `id`, `label`, `tools?`,
`entities?`, `layers?(scene)`, `handlers?(ctx)`, `panels?`, `statsPanel?`, `shortcuts?`,
`onActivate?(ctx, scope)`. Every generic is erased to `unknown` at the boundary and method
syntax makes the contribution assignable — a module writes `ModuleView<LightingData>` and the
registry holds `ModuleView<unknown>`.

`ModuleDefinition` gained `label: string` (required) and `loadRuntime?(): Promise<ModuleRuntime>`.
**`loadRuntime` is already a real dynamic `import()`** — `() => import('./lighting/runtime')` in
`modules/codecs.ts`. Writing it any other way would have pulled `three` into the eager barrel and
needed rewriting in phase 5. The build already emits a separate `runtime-*.js` chunk; the _bundle
check_ and routing are still phase 5's.

**`EditorRenderer`.** It holds `coreLayers: SceneLayer[]` (from `rendering/coreLayers.ts`:
`core.walls`, `core.doors`, `core.obstacles`) plus `moduleLayers`, and `render(view)` loops over
both honoring `SceneLayer.inputs?`. What stayed imperative and named: the phantom line, the
preview vertex, snap guides, the selection box, the measurement line and the door preview. Those
are gesture visuals, not projections of the document, so a layer would have nothing to derive
them from. `updateWalls`/`updateLights`/`updateDoors`/`updateObstacles`/`setPreviewLight`/
`setLightsVisible`/`setLightRadiusVisibility` are gone.

Lighting contributes six layers: `lighting.{fixtures,heatmap,shadows,rafters,deadZones,spacingWarnings}`.
`spacingWarnings` is computed inside its layer from the view and never stored (invariant 5); the
`spacingWarnings` store in `modules/lighting/store.ts` is now unused by the editor and kept only
for the panels.

**Two real bugs the phase surfaced.**

- **Renderers emptied their group but never unparented it.** Harmless when a renderer is built
  once per canvas; a leak that grows with every mode switch now that a module's renderers are
  rebuilt per activation. Fixed in `LightRenderer` and in the core renderers with the same shape.
  `../../../tests/unit/stores/moduleActivation.test.ts` asserts zero orphaned scene children across
  activate → deactivate → activate.
- **A guarded slice must not forward `invalidate`.** Svelte's `derived` marks a dependency
  pending on `invalidate` and clears it on the matching `run`, and refuses to recompute while
  anything is pending. `slice()` in `sessionStore.ts` and `documentSlice()` forwarded
  `invalidate` straight through while suppressing the `run`, so the **first suppressed emission
  wedged every `derived` above them permanently**. Latent since 1b — `canPlaceLights`,
  `roomBounds` and `spacingWarnings` were all affected — and phase 4 is the first code to put a
  `derived` over one in a way that shows (the module's tool never appeared in the toolbar). Both
  now ignore `invalidate`. **Any future guarded store must do the same.**

**`Diagnostics.warnings` got UI.** `../../../src/app/DiagnosticsBanner.svelte` — a dismissible panel
listing decode warnings and any failed runtime, with the reassurance that unreadable data is
preserved on save. Session-scoped; a new load brings it back.

**What is live in the boundary lint, and what is allow-listed.** Everything phase 0 wrote is now
enforced for real and nothing needed allow-listing:

- `floorplan/**` may not import `modules/**` or `app/**` — clean, via the entity seam.
- `modules/a/**` may not import `modules/b/**` — nothing to test yet; `MODULE_IDS` in
  `../../../eslint.config.js` still needs a new module id added by hand.
- `modules/*/codec.ts` and `commands.ts` may not import `three`, `*.svelte` or `runtime` — clean.
  Note the rule covers only those two filenames: `entities.ts`, `selection.ts`, `constants.ts`
  and `types.ts` are also eager-safe by construction but are not policed. If phase 5's bundle
  check finds `three` in the initial chunk, widen `EAGER_MODULE_ENTRYPOINTS`.
- `app/**` may import from anywhere — used by `Toolbar` (lighting's overlay toggles) and the
  viewer.

`../../../eslint.config.js` itself is unchanged.

**Deliberately not done / deferred.**

- **The eager chunk still contains most of lighting**, because `app/Toolbar.svelte` imports
  `modules/lighting/store` and `statsStore` for the Rafters / Dead Zones / Spacing / Stats /
  Lights buttons, and `App.svelte` renders `LightToolPanel`, `RafterControls` and
  `LightDefinitionManager` directly. That is legal (`app/**` may import anything) but it is what
  will fail phase 5's bundle check. The fix is a module-contributed "overlay toggles" and
  "tool panel" surface, or lazy `<svelte:component>` behind `$activeModule`. **Phase 5 must
  budget for this.**
- `ModuleRuntime.statsPanel` is rendered by `App.svelte` off `$activeModule`, but the _toggle_
  for it is still a hardcoded lighting button in `Toolbar.svelte`.
- `Interaction` still has two variants; `drawing`/`measuring` remain in `WallBuilder` and
  `MeasurementController`. `Session.document` is still `EditorDocument`, not
  `DeepReadonly<EditorDocument>`.
- `DisplayPreferences.lightRadiusVisibility` is still a lighting-shaped field on a core document
  type, and `roomStore` still exports `canPlaceLights` (identical to `canPlaceDoors`). Both are
  cosmetic; a codemod, not a phase.
- Share URLs are still `#/viewer?d=…`; routing, the mode picker and module-aware share links are
  phase 5.
- `LightManager`'s internal map is now write-only (hit-testing moved to `EntityAccess`); it
  survives only as the fixture factory `LightPlacementHandler` uses.

**Exactly what phase 5 must know.**

1. **Activation is already async and already lazy.** `activateModule(id)` /
   `deactivateModule()` / `activeModule` / `toolbarTools` / `activeView` / `activeEntities()` are
   exported from `floorplan/stores/moduleActivation.ts`. Routing means calling `activateModule`
   from the route instead of `App.svelte`'s `onMount`, which is one line (`../../../src/app/App.svelte`,
   inside the `currentRoute === 'editor'` branch).
2. **The scene must be set before layers can be built.** `Canvas.svelte` calls
   `setModuleScene(scene.scene)` in `onMount` and `setModuleScene(null)` in `onDestroy`.
   Activating with no scene yields an active module with zero layers — it does not throw, but it
   also does not draw. Child-before-parent `onMount` ordering is what makes today's sequence work.
3. **`sessionStore.beforeOpen` already handles "a document open lands mid-activation."** The
   rapid-navigation half of phase 5's acceptance criteria is covered by the generation token and
   tested in `../../../tests/unit/stores/moduleActivation.test.ts`; the routing half is not.
4. **The bundle check will fail until the shell stops importing lighting eagerly** — see above.
5. `generateShareUrl(input, moduleId)` already takes the module id; `encodeDocument` already
   takes `{ kind: 'share', moduleId }` and throws when that module is quarantined. What is
   missing is the `#/{module}` path and the picker UI.
6. `registeredModules()` returns `{ codec, commands, label, loadRuntime }` — enough for a mode
   picker without loading any runtime.
7. **Adding a module** now means: `codec.ts` + `commands.ts` + `runtime.ts`, a `ModuleDefinition`
   in `modules/codecs.ts`, and its id in `MODULE_IDS` in `../../../eslint.config.js`. Everything else —
   tool button, panels, layers, shortcuts, entity hit-testing, delete, snapping — falls out of
   the manifest.

**Tests.** 516 pass (477 inherited plus 39). New suites:
`../../../tests/unit/types/moduleRegistry.test.ts` (every registration failure, core-wins shortcut
precedence, and `CORE_RESERVED_SHORTCUTS` checked against the shell's actual bindings),
`../../../tests/unit/stores/moduleActivation.test.ts` (the three acceptance criteria plus dedup and
open-deactivates-first), `../../../tests/unit/modules/lightingRuntime.test.ts` (the real module through
the real registry, and fixtures as entities), `../../../tests/unit/rendering/sceneLayers.test.ts` (the
loop, the `inputs` guard, and who disposes what). `../../../tests/helpers/entities.ts` binds lighting's
entities to a test-controlled document, which is how the drag and selection-store tables get an
`EntityAccess`. `sessionStore.test.ts` gained the `derived`-over-a-guarded-slice regression.

`npm run test:run`, `npm run type-check`, `npm run lint`, `npm run build` and
`npx prettier --check .` all pass. `npx svelte-check` is at 4 pre-existing errors
(`FloatingPanel`, `Canvas`'s `originalPositions: null`, and two in `LightInfoBottomSheet`), the
same count phase 3b left. The app was additionally smoke-tested by loading it in headless
Chrome and asserting the module's tool button reaches the toolbar — which is how the
`invalidate` bug was found.

#### Phase 5

Commits: `83eb465` (routing, the mode picker, module-contributed UI surfaces), `d386d00` (the
bundle check), `4ec5eac` (tests), `99ed779` (the entity-count store).

**The route table, as built** (`../../../src/app/routerStore.ts`).

| Hash                | Route                                      | Note                             |
| ------------------- | ------------------------------------------ | -------------------------------- |
| `#/`                | `{ kind: 'editor', moduleId: 'lighting' }` | **Permanent** alias.             |
| `#/viewer`          | `{ kind: 'viewer', moduleId: 'lighting' }` | **Permanent** alias.             |
| `#/modes`           | `{ kind: 'picker' }`                       | The mode-picker landing route.   |
| `#/{module}`        | `{ kind: 'editor', moduleId }`             | Only if the module is installed. |
| `#/{module}/viewer` | `{ kind: 'viewer', moduleId }`             | What new share links emit.       |
| anything else       | `{ kind: 'picker' }`                       | Including an uninstalled module. |

- `Route` is a union, not a string. `currentRoute` and `routeParams` are hand-written guarded
  slices over one `writable` (a `derived` would re-emit on every hash change, and the phase-4
  rule stands: **a guarded slice must not forward `invalidate`** — these subscribe with the
  `run` callback only).
- **The two bare forms are read, never written.** `routePath(route)` is always
  module-qualified, so a link copied out of the address bar names its mode. `parseRoutePath` is
  pure and exported, which is what the route table test drives.
- **An uninstalled module id resolves to the picker, not to lighting.** Silently showing a
  different mode's document is worse than asking. This is the one route decision the plan does
  not specify.
- The mode picker is at `#/modes` rather than at `#/`, because the plan requires bare `#/` to
  resolve to lighting permanently — the two cannot both be the landing route. It is reachable
  from the toolbar's branding block, which shows the active module's label.
- `../../../src/app/moduleRouting.ts` is the route → activation glue, extracted from `App.svelte` so a
  test can drive it: `applyRoute(route)` activates for an editor route and deactivates for the
  picker and the viewer; `startModuleRouting()` subscribes and returns the unsubscribe. It
  never awaits one activation before starting the next — a route change is synchronous and the
  user is allowed to out-run an `import()`.
- `shareUrl.ts` builds `#/{moduleId}/viewer?d=…` itself rather than importing the router
  (`floorplan/` may not import `app/`). That is the only duplicate of the route shape, and
  `../../../tests/unit/app/routerStore.test.ts` asserts a generated link parses back to its module.

**The eager-chunk problem, and what `ModuleRuntime` gained.**

Phase 4's warning was accurate: `Toolbar.svelte` imported lighting's store and `statsStore` for
the overlay toggles and `App.svelte` rendered `LightToolPanel` / `RafterControls` /
`LightDefinitionManager` directly, so most of the module was in the initial chunk. Two new
manifest fields fix it, plus one deletion and one dynamic import:

```ts
/** Toolbar toggles, rendered in the shell's Overlay section while this module is active. */
readonly overlays?: readonly OverlayToggle[];
/** Free-standing UI mounted for as long as the module is active. Each takes no props. */
readonly surfaces?: readonly PanelComponent[];
```

```ts
export interface OverlayToggle {
  readonly id: string; // `${moduleId}.${verb}`, claimed like a tool id
  readonly label: string;
  readonly title: string;
  readonly icon: string; // raw SVG markup, same contract as ToolDescriptor.icon
  readonly active: Readable<boolean>;
  toggle(): void;
}
```

- **`active` is a `Readable`, not `(view) => boolean`.** Some overlays are document data
  reachable through the view (rafter visibility) and some are session-local presentation state
  deliberately not in the document (the stats panel, the definition-manager modal). One shape
  covers both. A module handing _out_ a read-only store is not a module being handed one —
  invariant 6 is about what a module may read of the session.
- **`statsPanel` is gone**, folded into `surfaces`. It existed only because the shell had to
  name it; a surface guards its own visibility, so there is nothing left to distinguish.
  `ActiveModule.statsPanel` became `ActiveModule.surfaces`.
- **New stores on `moduleActivation.ts`:** `moduleOverlays`, `moduleSurfaces` and
  `moduleEntitySummary` (`{ label, count } | null`, derived over `activeView` so it tracks the
  live document). `EntityDescriptor` gained `label: string` (a plural noun, `'Lights'`) and
  `EntityAccess` carries it; that is what the core property panel's count row reads now.
- `validateRuntime` claims overlay ids in their own table, with the same namespacing and
  duplicate checks as tool ids.
- **`ViewerPage` is loaded with a dynamic `import()` from `App.svelte`.** The viewer is a whole
  second page and it is lighting-shaped end to end (heatmap, shadows, a light info sheet);
  importing it statically put the shaders back in the editor's chunk. It is the one place
  outside `modules/` that still imports lighting directly, and that is fine now that it is
  lazy.
- **Definition adoption moved into the module.** `adoptIncomingDefinitions` takes
  `LightDefinition[]` instead of a document, and lighting's `onActivate` subscribes it to
  `committedLightingData` (a guarded slice, so it runs on activation and then only when the
  slice changes — every load re-activates via `sessionStore.beforeOpen`). The three shell call
  sites are gone. The viewer, which has no activation registry, still calls it by hand.
- Smaller consequences: `Toolbar`'s "start a new project?" prompt asks `walls.length > 0 ||
canUndo(history)` instead of counting fixtures; the Stats and Lights buttons moved from the
  toolbar's "More" section into "Overlay", where the rest of the module's toggles are; the
  `Radius` toggle stays core because `lightRadiusVisibility` is still a core document field
  (the phase-4 note about that wart stands).

After all of it, `src/app/**` outside `viewer/` has exactly one import from `modules/`:
`routerStore.ts` reading `LIGHTING_MODULE_ID`, which is eager by definition and is what makes
the permanent aliases mean something.

**The bundle check** — `../../../scripts/check-bundle.mjs`, `npm run check:bundle` (which builds first).

- `../../../vite.config.ts` sets `build.manifest: true`. The script walks the manifest's **static**
  `imports` transitively from the entry chunk and deliberately does not follow
  `dynamicImports`; the result is the set of files a browser must fetch before it can render.
  Today that is one chunk.
- Assertions are string-content matches, because chunks are minified and identifiers are
  mangled while string bodies are not. Markers are matched **without surrounding quotes** — the
  minifier rewrites quoting and emits backticks.
  - **Absent:** the IES parser (`TILT=`, `Invalid IES file`), the heatmap shader
    (`uLightBeamAngles`, `MAX_OBSTACLE_VERTICES`), the shadow shader (`uLightPosition`,
    `uPolygonVertices[64]`).
  - **Present:** lighting's codec (`lighting slice must be an object`), its command table
    (`fixture.move`, `rafterConfig.set`), the document codec (`quarantin`,
    `geometryChangedSinceLoad`).
- Verified to actually fail: adding a static `IESParser` import to `StatusBar.svelte` produced
  the expected failure, then was reverted.
- **If a marker string is ever reworded the check goes green for the wrong reason** for the
  REQUIRED set and red for the wrong reason for FORBIDDEN. Update the markers with the message.

**The share dialog, and the 8000-character threshold.**

`../../../src/app/ShareDialog.svelte` replaces the toolbar's fire-and-copy button. It lists every
installed module (from `registeredModules()`, so no runtime loads), defaults to the active mode
without overriding a later choice, shows the URL and its length inline, and **disables a module
whose slice is quarantined** — `encodeDocument` throws for one, and the dialog stops it before
anyone has to read the exception. `ViewerToolbar` shares the route's module id.

The threshold was revisited as the plan asks, and the conclusion is not the one the plan hints
at. 8000 is a **server** limit — the default request-line cap in nginx and IIS — and a share
payload lives in the URL _fragment_, which is never sent to a server at all. So the number was
never measuring what it named, and "a link now carries one module instead of two" is a reason
the warning fires less often rather than a reason to pick a different number. The pair is now:

- **2000** — where third-party surfaces (chat clients, ticket fields, QR codes) truncate a
  pasted link. Unchanged, and it is the warning that matters in practice.
- **32000** — a conservative floor across browsers' own address-bar and history limits, with a
  message that says to export JSON instead.

Both are named constants in `shareUrl.ts` with that derivation written down.

**Deliberately not done / deferred.**

- **The viewer is still lighting-shaped.** It takes the route's `moduleId` as a prop and uses
  it for the share button, but it builds lighting's layers by hand (it has no editor session
  and therefore no activation registry) and its stats panel is lighting's. Making it
  module-generic means giving it an activation scope, which is worth doing when there is a
  second module with something to view. Today `#/flooring/viewer` is unreachable because the
  route rejects an uninstalled module.
- `Interaction` still has two variants; `drawing`/`measuring` remain in `WallBuilder` and
  `MeasurementController`. `Session.document` is still `EditorDocument`, not
  `DeepReadonly<EditorDocument>`. `DisplayPreferences.lightRadiusVisibility` is still a
  lighting-shaped field on a core type, and `roomStore.canPlaceLights` still exists.
- The mode picker is a list of cards with no per-mode preview or document state. It does not
  need one until a document can carry two modes' data.
- No route-level code splitting beyond the viewer and the module runtimes. The initial chunk is
  ~755 kB, nearly all of it THREE.

**Verification.** `npm run test:run` (542 tests, 33 files — 516 inherited plus 26),
`npm run type-check`, `npm run lint`, `npm run build`, `npx prettier --check .` and
`npm run check:bundle` all pass. `npx svelte-check` is at the same 4 pre-existing errors
(`FloatingPanel`, `Canvas`'s `originalPositions: null`, two in `LightInfoBottomSheet`).

The app was driven in headless Chrome (`--headless=new --use-angle=swiftshader
--enable-unsafe-swiftshader --virtual-time-budget=8000 --dump-dom` against `vite preview`;
**without the swiftshader flags `Scene` throws on WebGL context creation and `App`'s `onMount`
never runs**, which reads as "routing is broken" and is not). Confirmed: every route in the
table renders the right page; the module's five overlay toggles and its tool button reach the
toolbar from the lazy runtime; a share payload loads through both `#/viewer?d=…` and
`#/lighting/viewer?d=…`. A second pass through an iframe harness drove client-side hash
navigation — `#/lighting` → `#/modes` → `#/lighting` → four rapid alternations — and ended with
exactly one copy of each overlay button, i.e. one active module and no duplicated
contributions.

**Tests.** `../../../tests/unit/app/routerStore.test.ts` (the route table including both permanent
aliases and the uninstalled-module case, `parseHash` not corrupting an lz-string payload,
`routePath` round-trip, and a generated share link parsing back to its module).
`../../../tests/unit/app/moduleRouting.test.ts` (the acceptance criteria: `#/lighting` → `#/flooring` →
`#/lighting` with all three loads in flight and resolved out of order; the same with the
intermediate load resolving last; picker and viewer routes leaving nothing active;
`startModuleRouting` following real `hashchange` events; and a `sessionStore.open` landing
mid-activation — each asserting exactly one active module, exactly one scene child and exactly
one live subscription). **Both modules there are stubs with controllable load timing**, which
is the point: the activation machine is proven before a second real module lands.
`moduleRegistry.test.ts` gained overlay-id namespacing and duplicate cases.

**Exactly what phase 6 must know to author a second module from scratch.**

Registering `flooring` is six steps and no core changes:

1. **`../../../src/modules/flooring/codec.ts`** — export `FLOORING_MODULE_ID = 'flooring'` and a
   `ModuleCodec<FlooringData>`: `id`, `schemaVersion` (≥ 1), `defaultData()` returning a
   **freshly allocated** value every call (the shared contract test asserts
   `defaultData() !== defaultData()`), `decode(blob)` returning a status rather than throwing,
   and `compactForShare?` returning `FlooringData` at the current `schemaVersion`.
2. **`../../../src/modules/flooring/commands.ts`** — one `defineCommand(codec, verb, spec, options?)` per
   edit, and a `flooringCommands: readonly RegisteredCommand[]` array. Pass
   `{ absolute: true }` for every member of the move-and-set family; the contract test asserts
   applying an absolute command twice equals applying it once. Verbs are bare (`layout.configure`);
   `defineCommand` prefixes the module id.
   Neither file may import `three`, a `*.svelte` component, or `runtime.ts` — the lint enforces
   it, and the bundle check enforces the consequence.
3. **`../../../src/modules/flooring/runtime.ts`** — export a `ModuleRuntime` with `id` (must equal the
   codec id) and `label`, plus any of: `tools` (ids `flooring.*`, each carrying its own inline
   SVG `icon` and an optional single-letter `key`), `overlays` (ids `flooring.*`, each with a
   `Readable<boolean>` and a `toggle()`), `entities` (an `EntityDescriptor` whose `selection`
   is `defineSelection('flooring', …)` and which carries a plural `label`), `layers(scene)`,
   `handlers(ctx)`, `panels` (keyed by `SelectionKind.panelKey`), `surfaces` (prop-less
   components that guard their own visibility), `shortcuts` (not one of
   `CORE_RESERVED_SHORTCUTS`), and `onActivate(ctx, scope)`. **Nothing here disposes anything**
   — hand every disposer to `scope.own`, and pass `scope.signal` to async work.
4. **`../../../src/modules/codecs.ts`** — add a `ModuleDefinition` with `codec`, `commands`, `label` and
   `loadRuntime: () => import('./flooring/runtime').then((m) => m.flooringRuntime)`, and
   register it in `installModules()`. It must be a real dynamic `import()` or the bundle check
   fails.
5. **`../../../eslint.config.js`** — add `'flooring'` to `MODULE_IDS` or it gets no cross-module
   enforcement. (It is already in the list.)
6. **`../../../scripts/check-bundle.mjs`** — add the module's own forbidden markers (its renderer's
   shaders, any parser) and required markers (a codec message, a command verb). The check only
   proves what it is told to look for.

Nothing else. The route (`#/flooring`, `#/flooring/viewer`), the mode-picker entry, the toolbar
button, the overlay toggles, the mounted panels, entity hit-testing, box select, grab, snap,
measure, Delete, the share dialog's module row, and the property panel's count row all fall out
of the manifest. Two things that do **not**: a share link for a module whose runtime cannot
render is still generated (data status and runtime status are independent, by design), and the
**viewer is not module-aware** — `#/flooring/viewer` will route but render lighting's canvas,
so either generalize the viewer or leave flooring editor-only for the phase.

One more constraint the plan already names and phase 6 will meet first: **planks are not
entities.** `EntityDescriptor` is for selectable, movable _points_; planks are derived output.
Transitions and the layout origin fit the seam, planks want `SceneLayer.inputs?` and the
projection requirements in "Derived data is a projection over narrow inputs".

#### Phase 6

Commits: `a7b7f80` (the module, plus the three core/shell files a second module forced),
`5867daa` (the engine, projection, runtime and store tests, and the engine changes those tests
forced).

**What shipped, and what it is made of.**

```
src/modules/flooring/
  types.ts              PlankSpec, LayoutConfig, Transition, defaults, presets   EAGER-safe
  codec.ts              FlooringData, flooringCodec, liveTransitions            EAGER
  commands.ts           five defineCommand handlers                             EAGER
  constants.ts selection.ts entities.ts                                         EAGER-safe
  PlankLayoutEngine.ts  pure (boundary, obstacles, plank, layout, origin) -> floor
  PlankIndex.ts         uniform-grid spatial index over the derived floor
  layoutProjection.ts   Projection<I,O> + layoutInputsOf + createLayoutProjection
  store.ts              guarded reads, one command per write, the layout service
  layers.ts handlers.ts runtime.ts                                              LAZY
  rendering/            PlankRenderer (InstancedMesh), TransitionRenderer, OriginMarkerRenderer
  ui/                   FloorLayoutPanel, CutListPanel, OriginPropertiesPanel
```

`FlooringData` is `{ plank, layout, origin, transitions }` — four small values. There is no field
for planks, a cut list, waste or square footage anywhere on it, and `defaultData()` has exactly
those four keys (asserted).

Commands, all namespaced by `defineCommand`: `flooring.layout.configure`, `flooring.plank.set`,
`flooring.origin.move` (all `{ absolute: true }`), `flooring.transition.add`,
`flooring.transition.remove`. `plank.set` is one beyond the plan's list and is unavoidable — the
plank spec is editable and the plan's list only names the layout. `layout.configure` sets the
whole config rather than one field per command, because the undo entry a user wants is "Change
floor layout", not eight of them.

**Deliberately deferred, and why.** Depth was cut, not pieces — everything listed in the phase
scope works end to end.

- **The transition is a decision, not cut geometry.** A `Transition` names a `Door` and a kind;
  it is drawn as a strip on that doorway and listed in the summary, but it does **not** break the
  plank run or add a threshold-width gap to the layout. Doing that properly means a second class
  of interval subtraction and a rule for which side of the threshold each room's floor stops on,
  which is a connected-rooms feature (`boundary: WallLoop` -> `boundaries: WallLoop[]`) rather
  than a flooring one.
- **No H-joint rule.** The stagger rules position each row's first joint; they do not enforce a
  minimum offset between joints in _adjacent_ rows, which is the check an installer actually
  makes. `random` in particular can put two rows' joints within an inch of each other. The seam
  for it is `rowOffset`, one function.
- **The purchase model has no defect allowance.** It simulates off-cut reuse and reports the
  geometric waste (typically 0.3-3% for a room that tiles well); the trade's "add 10%" is
  purchasing judgement and inventing a number for it would make the figure look more
  authoritative than it is. This is written down in the engine.
- **No worker.** The projection is _relocatable_ — `schedule` and an output-only `subscribe` are
  the seam, and a test drives it with a scheduler that never runs — but the relocation is not
  done because a 700-plank layout computes in single-digit milliseconds.
- Also not done: 3D, plank textures or a material library, box/SKU counting, editing a
  transition's kind after placement (the tool toggles trim on and off), and a fix-it action for
  the `MAX_PLANKS` truncation banner.
- **A named approximation.** Rows are laid by scan-lining one line per row, so where the room's
  outline changes _within_ a row's band — a diagonal wall, or the inside step of an L — that row
  is laid as if the whole band looked like its centreline. The error is bounded by (step length x
  one plank width), it under-reports rather than over-reports, and an L-shaped 300 sqft room comes
  out at 299.2. For a rectilinear room and for every obstacle this editor draws, the result is
  exact. A polygon boolean would remove it and would not give a cut list, which wants piece
  _lengths_ along the run.

**The projection interface, as designed.**

`Projection<I, O>` lives in `../../../src/modules/flooring/layoutProjection.ts`, **not** in the core
contract — ADR 0001 deferred it pending a consumer, and there is exactly one. Promoting it later
is a file move; specifying it before flooring existed would have been the mistake the ADR
declined with the monorepo.

```ts
interface Projection<I, O> {
  get(inputs: I): O | null;                       // never blocks
  subscribe(listener: (value: O) => void): () => void;
  readonly computations: number;                  // test seam
}
createProjection<I, O>({ key, compute, signal, schedule?, cacheSize? })
```

| Requirement    | How it is met                                                                                                                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Narrow inputs  | `layoutInputsOf(view)` returns `{ walls, isClosed, obstacles, plank, layout, origin }` and nothing else — no `Session`, no document, no selection, no view mode, no display preferences. A test asserts the key is unchanged across a selection change. |
| Keyed cache    | `layoutKey(inputs)` is the full canonical structural form (not a hash — a collision would render the wrong floor silently). Insertion-order LRU where a hit moves the key to the young end, so undo _and_ redo across a config change are both hits.    |
| Cancellable    | Takes the activation scope's `AbortSignal`. Abort cancels the pending schedule, drops the listener set, and short-circuits delivery; `computePlankLayout` also checks the signal between rows.                                                          |
| Last-good-wins | A miss returns the previous layout and schedules the new one. 120 simulated pointer moves serve a floor on all 120 frames and run **zero** computations; the coalesced computation runs once, for the newest key, when the scheduler fires.             |
| Relocatable    | Work goes through `schedule` (default: a macrotask, so the frame paints first) and results arrive only through `subscribe`. `compute` is a pure function of plain data — it round-trips through `JSON.parse(JSON.stringify(...))` unchanged.            |

`SceneLayer.inputs?` is the seam at the render end, implemented for the first time here:
`flooring.planks` returns `${layoutKey(...)}|${viewMode}`, so hovering, selecting the origin or
opening a panel skips `update` entirely. Because the projection answers asynchronously, the plank
layer also subscribes to the layout store and pushes into the renderer directly — the layer owns
that subscription and releases it in its own `dispose`, which the scope calls.

**The plan's key risk, tested.** "Plank layout blocks the frame on pointer moves" is
`../../../tests/unit/modules/layoutProjection.test.ts` -> `last-good-wins` -> "dragging a wall never blocks
and never coalesces to more than one computation". It is the acceptance criterion, not a comment.

**Did obstacle-as-cutout and door-as-threshold actually work? Yes, both, unchanged.**

- **Obstacles.** `computePlankLayout` scan-lines each obstacle polygon exactly as it scan-lines
  the room and subtracts the intervals. `Obstacle` needed no field, `ObstacleRenderer` needed no
  change, and the drawing, dragging and vertex-editing machinery was already there. The flooring
  module contains no code that knows what an obstacle _is_ beyond "a closed polygon of
  `WallSegment`". A 4x4 island in a 20x20 room removes the right area, tested.
- **Doors.** A `Transition` is `{ id, doorId, kind }` — no wall id, no offset, no width, because
  `Door` has all three. Moving the door moves the threshold with **no flooring command
  dispatched at all** (asserted: the slice is reference-identical afterwards). The transition
  tool hit-tests core's doors through `getDoorEndpoints`, a core utility.
- **The one cost, and it is real.** Deleting a door leaves an inert transition behind, because a
  core command may not rewrite a module's slice and nothing else runs on `door.remove`. The fix is
  `liveTransitions(transitions, doors)`, which every consumer resolves through instead of trusting
  the id; the orphan is preserved (harmless, and it comes back if the user undoes the delete) but
  never drawn or counted. This is the general shape of the problem — **a module slice may hold a
  reference into geometry that core can invalidate** — and it will recur. Resolve-don't-trust is
  the cheap answer; a `geometry.changed` hook that let modules prune would be the expensive one
  and would give core a reason to know about modules again.

**What in core had to change — the actual verdict on the architecture.**

Three files in `../../../src` outside `../../../src/modules/flooring`, all for one reason, and nothing at all in
the write model, session, selection, persistence, interaction, activation, entity seam or render
loop:

1. `floorplan/types/moduleRegistry.ts` — `ModuleDefinition.viewable?: boolean` and
   `isModuleViewable(id)`. ~12 lines.
2. `app/routerStore.ts` — one condition: `#/{module}/viewer` resolves to the picker unless the
   module is viewable.
3. `app/ShareDialog.svelte` — a non-viewable module's row is disabled with "no viewer for this
   mode yet", and the default selection skips it.

All three exist because **the viewer is not module-generic** (see below), not because the module
contract was wrong. Nothing else was touched, nothing was allow-listed in the boundary lint, and
`ModuleRuntime` did not gain a single field for the second module — it gained `overlays` and
`surfaces` in phase 5 for the _shell's_ benefit, and flooring used them as they were.

Four test-side changes were forced, all artefacts of the suite having used the string `flooring`
as a placeholder for "a module that does not exist":

- `../../../tests/fixtures/envelope-v3-unknown-module.json` named `flooring`, so it silently started
  proving `unsupported` instead of `unknownModule`. Renamed to `plumbing`, with a note in the
  fixtures README.
- `../../../tests/helpers/documents.ts` seeded only lighting's slice, so every persistence round-trip test
  failed once a second module normalized in on load. `makeDocument` now spreads
  `createEmptyDocument().modules` first, which is module-agnostic and will not break again.
- `codecContract.test.ts` asserted exactly one registered codec.
- `routerStore.test.ts` used `flooring` as its uninstalled id; it now uses `plumbing` and gained a
  case for an installed-but-not-viewable module.

**Manifest vs. capabilities (ADR 0001): keep the manifest. Do not adopt
`capabilities: ModuleCapability[]`.**

The ADR deferred this to "when a second module can show whether the extension points actually
diverge". They did not diverge. Evidence:

- Flooring used nine of the manifest's optional members (`tools`, `overlays`, `entities`,
  `layers`, `handlers`, `panels`, `surfaces`, `shortcuts`, `onActivate`) and needed **no new
  one**. The interface did not grow by a single field for the second domain.
- Where the two modules differ, they differ in _values_, not in _kinds of contribution_. Lighting
  contributes a list of deletable point entities; flooring contributes exactly one entity that
  cannot be deleted. The seam took both with no change — `removeCommand` returning `null` was
  already the contract for "nothing to delete". A union of capability variants would have bought
  nothing here, because there was no second variant to name.
- The one thing a second module genuinely needed was **not a capability**. `viewable` is a fact
  about the installed module that the router and the share dialog must read _synchronously,
  before any `import()` resolves_, so it belongs on the eager `ModuleDefinition` and could not
  have lived in a capability list on the lazy runtime. That is an asymmetry the ADR did not
  anticipate, and it argues for keeping the eager/lazy split as the contract's primary axis
  rather than reshaping the lazy half.
- The one real benefit capabilities were argued to have — lifecycle per contribution — is still
  served by the activation scope, and flooring stressed it harder than lighting did: a projection
  cache with a pending timer and an `AbortSignal`, handed to `scope.own` in `onActivate`. It
  worked without any per-contribution lifecycle.

Revisit only if a third module needs a contribution whose _lifetime differs from activation_, or
whose multiplicity the shell must order. Until then, adding an optional field costs one line plus
a shell branch — the identical edit a union member would cost.

**The viewer: flooring is editor-only, and that is now stated rather than broken.**

Phase 5 flagged the choice. Generalizing the viewer is not a small edit disguised as one: the
viewer page has no activation registry (`applyRoute` deactivates for viewer routes), it builds
lighting's layers by hand, it keeps its own `selectedViewerLight` store, and its click handling
raycasts for `userData.lightId`. Giving it an activation scope means moving all four, and it is
its own phase-sized piece of work with no flooring content to show at the end of it — a read-only
plank layout is a picture of a floor.

So `viewable: false`, and the consequences are explicit: `#/flooring/viewer` resolves to the mode
picker (the same answer an uninstalled module gets, for the same reason — showing the wrong
mode's canvas under the right URL is worse than asking), and the share dialog disables the
Flooring row rather than minting a link that opens on nothing. Both are verified in headless
Chrome. When the viewer is generalized, `viewable` becomes `true` and nothing else changes.

**Engine decisions a future contributor will meet first.**

- **The run-aligned frame.** The room is rotated by `-runAngleDeg` about the origin and then
  mirrored so the configured start corner is always the local bottom-left. Four start corners and
  every run angle collapse into one code path. `toLocal`/`toWorld` are the only places that know.
- **The joint grid is anchored at the layout origin, not at the room's bounding box.** That is
  what makes dragging the origin visibly move every joint, and it is why the origin is an entity.
- **The last row is ripped, not dropped.** A row's band is clipped to the room and the plank
  carries the clipped width; dropping it would leave a strip of bare subfloor and under-report
  the area by up to a plank width across the room. A ripped board still costs a full-width one,
  which is where rip waste enters the figure.
- **The minimum end cut shifts the row's joint grid**, left if the last piece is short and right
  if the first is, accepted only when it does not break the other end. If neither can be fixed
  the original stands — a slightly wrong cut list beats an infinite loop.
- **Only a run-starting piece may consume an off-cut.** A mid-run board is full length and an end
  piece is by definition what is left over. Without that restriction the waste figure comes out
  at an unreachable 0.2%.
- `MAX_PLANKS = 20000` bounds every loop; a degenerate config reports `truncated` rather than
  hanging the tab.
- **Planks are not entities and must not become them.** They are re-derived on every geometry
  edit, so a selection naming one would be a reference into a value the next wall drag destroys.
  Hit-testing exists (`PlankIndex`, a uniform grid) and drives a hover read-out; that is the part
  that is useful without the pretence.
- The `PlankRenderer` grows its instance buffers with 25% headroom and truncates with
  `mesh.count`, so a wall drag re-derives allocation-free. `setHovered` rewrites colours only.

**Verification.** `npm run test:run` (625 tests, 37 files — 542 inherited plus 83),
`npm run type-check`, `npm run lint`, `npm run build`, `npm run check:bundle` and
`npx prettier --check .` all pass. `npx svelte-check` is at the same 4 pre-existing errors
(`FloatingPanel`, `Canvas`'s `originalPositions: null`, two in `LightInfoBottomSheet`).

`check-bundle.mjs` gained two FORBIDDEN entries (flooring's layer ids and its panel strings, both
of which pull in THREE and the engine) and two REQUIRED entries (its codec message and two
command verbs). Every marker was verified to exist in the built output and in the expected chunk,
because a marker that matches nothing passes a FORBIDDEN check for the wrong reason.

The app was driven in headless Chrome against `vite preview` (`--headless=new
--use-angle=swiftshader --enable-unsafe-swiftshader`; **without the swiftshader flags `Scene`
throws on WebGL context creation and `onMount` never runs**). Through an iframe harness that
seeded a v3 envelope into local storage — a 20x16 room with a door and a 4x3 island, plus a
flooring slice — and then drove the real UI: the module's tool and its three overlay toggles
reach the toolbar from the lazy runtime; the floor derives to 302.6 sqft, 130 boards, 0.3% waste
with a three-line cut list and the door listed as a threshold; hovering the canvas reports
"Row 16, board 5 — 48" (full)", which exercises projection -> `PlankIndex` -> handler ->
renderer; changing the stagger through the real panel re-derives the cut list (three lines ->
two) and produces one undo entry labelled "Change floor layout"; `#/flooring/viewer` lands on the
mode picker; `#/modes` lists both modes; and `#/lighting` -> `#/flooring` swaps the overlay sets
exactly, with no duplicates and no leftovers. No console errors at any point.

**Tests.** Four new suites.
`../../../tests/unit/modules/plankLayoutEngine.test.ts` — the engine as a pure table with no store, no
Svelte and no DOM: coverage of a rectangle, an L and an obstacle cutout, the ripped last row,
each of the five stagger rules, the minimum end cut in both directions, the cut list and the
waste model, the run frame and all four start corners, `layoutKey`, and bounded work.
`../../../tests/unit/modules/layoutProjection.test.ts` — the five requirements, one `describe` each.
`../../../tests/unit/modules/flooringRuntime.test.ts` — the second module through the real registry:
registration, the single-entity seam, the spatial index, activate/deactivate leaving zero
orphaned scene children, and lighting -> flooring -> lighting leaving exactly one module's panels
registered. `../../../tests/unit/stores/flooringStore.test.ts` — one command and one labelled history
entry per setter, live-versus-committed projections, and the doors-are-thresholds behaviours
including the inert-orphan case. `../../../tests/helpers/moduleSamples.ts` gained a payload for each of
the five commands, which is what puts them through the shared contract suite unchanged.
