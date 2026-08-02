# Studio Modularization Plan

**Status:** in progress — see [Implementation progress log](#implementation-progress-log).
**Created:** 2026-08-02
**Rejected alternatives and decision history:** [ADR 0001](../adr/0001-studio-modularization.md)

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
- Physically move lighting under `src/modules/lighting/`; author `runtime.ts`.
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

| Phase | Status      | Branch / commit     | Notes                                                                                                                                                                         |
| ----- | ----------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | done        | `modules` / c876e7e | Boundary rules live in `eslint.config.js`; inert until the target dirs exist. Add new module ids to `MODULE_IDS` there.                                                       |
| 1a    | done        | `modules` / f8c125e | Commands are the only write path; `roomStore` is now a derived live view over `committedRoom` + `interaction`. Read sites moved to the nested `EditorDocument` shape.         |
| 1b    | done        | `modules` / e738251 | One `Session` behind `sessionStore` + pure `reduceSession`; `roomStore`/`committedDocument` are guarded derived slices. `historyStore` and `settingsStore`'s mirror are gone. |
| 2     | not started |                     |                                                                                                                                                                               |
| 3a    | not started |                     |                                                                                                                                                                               |
| 3b    | not started |                     |                                                                                                                                                                               |
| 4     | not started |                     |                                                                                                                                                                               |
| 5     | not started |                     |                                                                                                                                                                               |
| 6     | not started |                     |                                                                                                                                                                               |

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
  top of `eslint.config.js`, since `no-restricted-paths` zones cannot express "any other sibling".
  **A new module must be added to that array or it gets no cross-module enforcement.**
- Only `import/no-restricted-paths` is enabled from `eslint-plugin-import`; no other rule from that
  plugin (e.g. `import/no-unresolved`) was turned on, to avoid noise on the existing tree.
- Rules were verified against throwaway fixture files under `src/floorplan`, `src/modules/*`, and
  `src/app` that reproduced each violation; the fixtures were deleted before committing. No
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

**Tests.** `tests/helpers/documents.ts` holds the fixtures (`squareRoom`, `rectWalls`,
`makeLight`, `makeDoor`, `makeObstacle`). New suites:
`tests/unit/commands/applyCommand.test.ts` (pure command table with a coverage assertion against
`registeredCommandTypes`, JSON round-trip, move/set idempotence),
`tests/unit/interactions/dragCommands.test.ts` (per-drag-kind pointer-sequence tables with snap and
axis-lock), `tests/unit/stores/interactionPreview.test.ts` (preview live / commit exactly once /
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

**Tests.** `tests/unit/stores/reduceSession.test.ts` is the pure table (no store, no Svelte, no
DOM) and covers the mixed label sequence, the 51-dispatch eviction plus 50 undos, open pushing
no entry while clearing interaction and selection, undo/redo clearing a pending drag including
one whose entity the restored snapshot no longer contains, and the dev freeze.
`tests/unit/stores/sessionStore.test.ts` covers the store boundary: one action one emission,
zero emissions for a no-op, and each narrow store's guard. `historyStore.test.ts` became
`sessionHistory.test.ts` (same scenarios, `sessionStore.undo/redo`, `clear()` scenarios
rewritten as `openDocument`). `settingsStore.test.ts` is new. 352 tests pass.
