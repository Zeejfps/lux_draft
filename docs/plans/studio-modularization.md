# Studio Modularization Plan

**Status:** proposed, not started.
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

Roughly 11k of the current ~19k LOC is domain-agnostic already: scene and input, geometry
(SnapEngine, PolygonValidator, WallBuilder, DimensionLabel), interactions and drag operations, core
rendering, persistence, controllers, and UI shell primitives.

Three pieces of domain luck are worth planning around:

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
   entry, one store emission. Commands are serializable data with absolute (never delta) payloads,
   and handlers are pure `(document, command) => document`.
3. **A drag previews a candidate command and dispatches that same value on completion.** The last
   frame the user saw is, by construction, the state that gets committed. Nothing writes the document
   mid-gesture, so history is never suppressed.
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
export interface CarriedState {
  quarantined: Readonly<Record<string, ModuleBlob>>;
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

| Property                      | Enforced by                                                              |
| ----------------------------- | ------------------------------------------------------------------------ |
| Serializable data only        | Dev-mode JSON round-trip assertion on dispatch; registry contract test   |
| Absolute payloads, not deltas | Contract test: applying a command twice equals applying it once          |
| Pure handlers                 | Handlers take no store; the command table tests run with no store or DOM |

Serializability is what makes logging, replay, fixture-based testing, and any future collaboration
possible; without it `EditorCommand` is a tagged callback. Absolute payloads are what make the drag
preview and the dispatch the same value rather than two computations that agree. Because the label
comes from the handler, it cannot drift from the operation — and keyboard nudge, property-panel
entry, and drag become three producers of one command instead of three code paths.

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

Two failure modes justify this. A handler that mutates its `doc` argument and returns it makes
`deepEqual(next, current)` trivially true, so the reducer treats a real edit as a no-op and undo
skips it. And a `defaultData()` returning a shared object gets that reference normalized into the
document; a mutation then drifts the baseline prune-on-save compares against, the slice is pruned,
and the data is silently dropped — surfacing long after the commit that caused it. The shared codec
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
  subscriptions, projection caches, workers, and pending async work are all registered with it. Naming
  only layers and handlers leaks the rest — and flooring's layout engine holds both a subscription
  and a worker.
- **Dedup.** A second `activate()` while `loading` returns the in-flight promise. `import()` is
  idempotent; the scope construction that follows is not.
- **Generation token.** Each activation increments a counter; a resolution whose token is stale
  constructs nothing and disposes nothing, because it never built anything.
- **The registry owns disposal.** Modules never dispose their own contributions. `open(loaded)`
  deactivates before swapping documents, so no layer sees two unrelated documents.
- **The module record is cached; the scope is not.** It binds a `THREE.Scene` and a `ModuleContext`
  and is rebuilt per activation. Caching it is the straightforward way to leak a scene.
- **Failure is session-scoped.** See the two-status model below.

### Registration validates and fails fast

The design depends on unique strings, and a duplicate shadows silently — surfacing later as the wrong
codec decoding a slice, the wrong handler applying a command, or a panel rendering for the wrong
selection. Registration throws on: duplicate module id; `runtime.id !== codec.id`; duplicate command
type, tool id, layer id, or panel key; a tool id or command type not namespaced with the module id;
an already-bound shortcut.

Shortcut precedence is explicit rather than registration-order: **core wins over modules, and a
module-vs-module conflict is a registration error** — detectable even though only one module is active
at a time, and better caught then than when a user finally has both installed.

These live in a shared registry contract test every module is run through.

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
/** Document-scoped. Decided at decode; determines what is written back. */
export type ModuleDataStatus =
  | { kind: 'live' }
  | { kind: 'quarantined'; reason: 'unsupported' | 'invalid' | 'unknownModule'; message?: string };

/** Session-scoped. Lives in Diagnostics, never in the document or envelope. */
export type ModuleRuntimeStatus =
  | { kind: 'inactive' }
  | { kind: 'loading' }
  | { kind: 'active' }
  | { kind: 'failed'; message: string };
```

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

Quarantined means: mode not selectable, no default materialized, no commands registered, blob written
back unchanged. Runtime-failed means: mode not selectable this session, nothing else changes. In both
cases geometry and the other module stay fully editable (invariant 8).

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
  committedRoom.update((doc) => applyCommand(doc, c));
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
- Repoint persistence, autosave, and `historyStore` at `committedRoom` — the only sites that must not
  see previews.
- Wire `pointercancel` and window `blur` to cancel the interaction. Not wired today.

Acceptance criteria:

- A pure `(document, command) → document` table covers every handler, running with no store or DOM.
- Per drag kind, a `(pointer sequence) → command` table asserts snap and axis-lock land correctly.
- Each drag previews live, writes the committed document exactly once, writes nothing when it ends at
  its origin, and leaves it untouched on cancel.
- Every dispatched command survives a JSON round-trip value-identically.
- Applying any command twice equals applying it once.

**Key risk:** rewriting the drag operations regresses interaction feel. Mitigated by landing against
current stores with per-op tests, and by converting `GrabModeDragOperation` last.

**Ships alone:** removes history suppression, fixes drag cancel by construction, stops autosave
capturing mid-drag documents, and makes the edit surface testable without a store.

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

**Ships alone:** removes the `JSON.stringify` on every emission, gives undo entries real labels, fixes
the load-pushes-undo bug, and reduces the state machine to one testable function.

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

- Define `ModuleCodec` / `ModuleBlob` / `DecodeResult` / `ModuleDataStatus`, the opaque `ModuleSlices`
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

**Ships alone:** the v1/v2 readers and their fixtures are permanent assets regardless of what follows.

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
| Someone reimplements history as a command log                       | Inverses are a second implementation; snapshots plus the 50-cap stay. See ADR 0001.             |
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
