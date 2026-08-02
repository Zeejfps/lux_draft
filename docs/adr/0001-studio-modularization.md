# ADR 0001 — Studio modularization: rejected alternatives

**Status:** accepted
**Date:** 2026-08-02
**Plan:** [docs/plans/studio-modularization.md](../plans/studio-modularization.md)

Design history for the Studio modularization. The plan states conclusions; this records what was
proposed and rejected, so the same branches are not re-argued. Each rejection below still holds.

---

## Repository shape

**Separate repo / fork the app.** Rejected — duplicates ~11k LOC of editor code that would diverge
immediately.

**Monorepo with shared packages now.** Rejected — premature with one shipping app. Costs workspace
tooling, build ordering, cross-package HMR friction, and version churn; buys nothing until a second
consumer has a separate release cadence. The decisive argument is asymmetry: a module registry does
not foreclose a later monorepo (flooring becomes a second Vite entry from the same tree, and only
then a package split), whereas going monorepo now is the only option that is expensive to undo.

---

## The write model

The document was an ambient mutable store, and `historyStore` _inferred_ that an edit happened by
subscribing to it and `JSON.stringify`-diffing. Because intent was inferred rather than declared,
every write path had to be careful about how often it emitted, what was inside the observed object,
and in what order it touched sibling stores. Three designs were tried before commands.

**`pauseRecording` / `resumeRecording` around drags.** Rejected — creates a mode in which the
document is written while history is off. Each review round found another rule that mode needed
(loads must pause then clear but never resume; a missed resume silently swallows history).

**Scoped `Gesture` handle (`begin` / `apply` / `transact`).** Rejected — the same mode, better
packaged. Its nesting rules, async-rejection rules, and leak hazard were all reporting that the mode
should not exist.

**`commit(label, fn)` as the public write API.** Rejected — removes the inference, which was the
point, but leaves the edit itself an opaque callback. A closure cannot be named, logged, serialized,
replayed, or tested without standing up a store, and nothing keeps the label in sync with what the
function does.

**`commit` + `commitModule` as two entry points.** Rejected — a single user action that touches
geometry and a module slice needed both, and emitted twice.

**`DragResolution` + a pure `applyDrag`, held equal to the commit path by a per-drag-kind test.**
Rejected — two implementations of the same geometry, kept in agreement by a test. Making the preview
_be_ the command deletes the test rather than passing it.

**Separate public `dispatch` then `setInteraction`.** Rejected — two emissions and an observable
`Session` in which the document already contains the drag's result while `interaction` still
describes it.

**A command log as the history representation.** Rejected — undo would require either an inverse for
every command or replay-from-origin on every keystroke. Inverses are exactly the second
implementation the command design exists to avoid. Snapshots with a 50-entry cap stay. Revisit only
alongside collaboration, where a command log is needed for a different reason.

---

## Document shape

**Flat `walls` / `doors` / `obstacles` / `isClosed` / `ceilingHeight` root.** Rejected — bakes "one
room, with a ceiling, lit" into the core type. Nesting under `geometry.boundary` is what lets
`boundary: WallLoop` become `boundaries: WallLoop[]` for connected rooms and thresholds without
rewriting every module that reads geometry.

**`ceilingHeight` inside the lighting slice.** Rejected, narrowly. Lighting is its only consumer
today, but a user editing "how tall is this room" does not think of it as a lighting setting, and
`space` costs one field. Demoting it into a slice later is easy; promoting it out requires a schema
migration.

**`RoomState` as both the editor type and the persisted type.** Rejected — schema versions, omitted
defaults, quarantined blobs, drift flags, and permanent legacy shapes would all become nameable from
editor code. Separating `EditorDocument` from `DocumentEnvelopeV3` makes one sentence true: the
decoder is the only code that handles hostile, legacy, or partial input.

**Global `lightDefinitions` carried in `CarriedState`.** Rejected — `definitionId` would reference
data outside the document, so undo, export, and share would each need a rule for keeping the two in
sync, and the existing "existing definition wins on import" bug would survive.

---

## Module contract

**`capabilities: ModuleCapability[]` replacing the runtime manifest.** Rejected for now. Proposed to
avoid an ever-growing interface, but it does not buy that: adding a capability costs a union member
_and_ a shell branch, the identical edit to adding an optional field _and_ a shell branch. "Modules
implement only what they need" is already true of optional properties, and multiplicity is already
handled (`layers()` returns an array, `panels` is a record). The one real benefit — lifecycle per
contribution — is served by the activation scope instead. Revisit in phase 6, when a second module
can show whether the extension points actually diverge.

**`Projection<I, O>` in the core contract now.** Deferred, not rejected. The requirements are real
(narrow inputs, keyed cache, cancellable, last-good-wins) and are recorded in the plan as phase-6
acceptance criteria. Specifying a generic projection framework before flooring exists repeats the
mistake declined above with the monorepo. `SceneLayer.inputs?` is the seam.

**One `disabled` flag per module.** Rejected — conflates "this build cannot read the data" with
"this session cannot display it". A runtime that fails to load must not stop valid data from being
written back at the current schema version.

**Blocking geometry edits while a module's data is quarantined.** Rejected — inverts the premise
that geometry is the shared asset. A module this build cannot even parse must not hold the room
hostage.

**Stamping a staleness marker inside the quarantined blob.** Rejected — we cannot parse it, so we
cannot safely modify it. Editing an opaque blob is how "preserved verbatim" stops being true. The
drift flag is recorded beside the blob instead.

**A separate share schema with its own version.** Rejected — buys nothing and doubles the migration
matrix. `compactForShare` returns `T` and share payloads are read by the ordinary decoder.

---

## Overclaims corrected during review

**"Derived output is unnameable from `codec.ts` because lint forbids importing `runtime.ts`."** A
lint rule is a guardrail, not a type-level proof — a developer can restate a structural type by hand
or route output through `unknown`. The guarantee is behavioral: nothing accepts a layout for
storage, every module write goes through a registered command, and the codec round-trip test asserts
the persisted shape.

**"`future` is bounded by `past`."** False — undo everything and `future` is 50 while `past` is 0.
The invariant is `past.length + future.length ≤ MAX_HISTORY`.

**"Undo during a drag is well-defined because there is no in-flight document write to conflict
with."** Incomplete. If the interaction survives an undo, the candidate command is re-applied to the
_restored_ document using ids and vertex indices resolved against the pre-undo one. Undo and redo
must clear the interaction in the same transition.
