# Layout Pins Plan

**Status:** proposed
**Created:** 2026-08-03
**Touches:** `../../src/modules/flooring/types.ts`, `codec.ts`, `commands.ts`,
`PlankLayoutEngine.ts`, `layoutProjection.ts`, `store.ts`, `ui/PlankInfoPanel.svelte`,
`ui/FloorLayoutPanel.svelte`, `rendering/PlankRenderer.ts`,
`../../tests/unit/modules/plankLayoutEngine.test.ts`

## Goal

Click a board, type a dimension, and have the rest of the floor lay itself around it — "the row
against this wall is 4 inches", "the piece at this end is 36 inches" — without any part of the
floor ceasing to be derived.

## The problem

Getting a particular board to a particular size is currently done by dragging the layout origin
marker and watching what happens. The board panel says so out loud: a board ripped below the
product's minimum tells the user to "nudge the layout origin or rip the first row too"
(`ui/PlankInfoPanel.svelte`). That is the right advice and the wrong interface — the user knows
the number they want and has to search for it by hand, one pixel of origin drag at a time.

The naive fix is a per-plank override: store "this plank is 36 inches" against the plank. It does
not survive contact with the module. A plank has no identity that outlives anything — the engine
is a pure function of (boundary, obstacles, plank spec, layout config, origin) and nothing about
its output is stored (invariant 5, `PlankLayoutEngine.ts` header). Change the stock width, drag a
wall, move the origin, and every row index and column index shifts underneath the override.

It is also not what a floor can physically do. A board in the middle of a run is a full board;
only three things on a floor are actually free, and each is a _phase_, not a piece:

| What can be pinned                  | What it really sets       | What pays for it                       |
| ----------------------------------- | ------------------------- | -------------------------------------- |
| Width of the row against a boundary | grid phase across rows    | the row at the opposite wall           |
| Length of the end piece of a row    | joint phase along the run | the piece at the other end of that row |
| Where a given joint lands           | the same phase, restated  | the same                               |

## Decision

Store the **pin**, not the solved origin, and inverse-solve it into the grid phase the engine
already computes as `ANCHOR_Y` / `ANCHOR_X`.

Storing the pin rather than moving the origin on the user's behalf is the whole reason this is a
feature rather than a numeric entry box on the origin marker. Solve once and write the origin, and
switching from 7" to 6" stock silently turns a 4" first row into 3". Store _"the row containing
this point is 4 inches"_ and re-solve, and it stays 4 inches through a stock change, a wall drag
and an undo. That is the same trade the module already makes everywhere: store intent, derive
output.

Two consequences fall out, and both are simplifications:

1. **A pin is periodic in one board.** A rip pin fixes `ANCHOR_Y` modulo `plankWidth`; a joint pin
   fixes `ANCHOR_X` modulo `plankLength`. So there are exactly two degrees of freedom to pin, a
   second pin of a kind _replaces_ the first, and the whole thing is two scalars in closed form.
   No constraint graph, no over-constrained state, no unsatisfiable-system UI.
2. **The cost is arithmetic, not a guess.** The two rips of a room sum to
   `(maxY - minY) mod plankWidth`, a property of the room and nothing else. Pin one end and the
   other is determined — which the panel can show while the user types, rather than after.

Rejected:

- **Per-plank geometry overrides.** No durable key to hang them on (above), and they would put
  stored output on a module whose central claim is that it has none.
- **A general constraint solver.** Two periodic scalars do not need one, and one would invite pins
  the floor cannot honour ("this middle board is 30 inches") by making them expressible.
- **Pins as fields on `LayoutConfig`.** `configureLayout` is a whole-form absolute write from
  `FloorLayoutPanel`; a pin set from the board panel would be clobbered by the next form edit.
  Pins go top-level on `FlooringData`, with their own command, exactly as `surfaces` did and for
  the same reason.

## Phases

Each phase is shippable on its own and leaves the tests green.

### Phase 1 — the rip pin

The whole feature in miniature, and the one that automates the hint the board panel already gives.

**`types.ts`** — the stored shape:

```ts
/**
 * "The row containing this point is W inches wide", solved back into the grid phase rather than
 * written onto a board.
 *
 * Anchored to a seed point for the reason `SurfaceAssignment` is: the thing being named is
 * derived and has no id that survives the next wall drag. `edge` is the disambiguation the seed
 * cannot carry — a board is ripped against the boundary below it or the one above it, and after
 * a wall moves the seed no longer says which. It is captured when the pin is made, from the
 * board actually clicked.
 */
export interface LayoutPin {
  seed: Vector2; // world space, feet
  targetIn: number; // inches
  edge: 'low' | 'high'; // which boundary the piece is measured from, run-frame
}

export interface LayoutPins {
  rip?: LayoutPin;
  joint?: LayoutPin;
}
```

**`codec.ts`** — `pins: LayoutPins` on `FlooringData`, `{}` in `defaultFlooringData`, a `readPins`
beside `readSurfaceAssignment` (absent → `{}`, `targetIn` finite and `> 0`, `edge` one of the two
strings, seed through `readVector2`), and a deep copy in `compactFlooringForShare`.

**No schema version bump.** Additive and absent-tolerant, like the optional arrays already there.
Bumping makes new documents _unreadable_ by older builds, which is strictly worse than an older
build rendering the same floor unpinned.

**`commands.ts`** — one command, whole-object and absolute, matching `setSurfaces`:

```ts
export const setLayoutPins: CommandKind<{ pins: LayoutPins }> = defineCommand(
  flooringCodec,
  'pins.set',
  {
    label: () => 'Pin board size',
    apply: (_doc, p, prev) => ({ ...prev, pins: clonePins(p.pins) }),
  },
  { absolute: true }
);
```

**`PlankLayoutEngine.ts`** — `readonly pins?: LayoutPins` on `LayoutInputs`, in `layoutKey` (a pin
moves geometry, so a layout cached under the old value would come back wrong), and one line at the
`ANCHOR_Y` definition:

```ts
const ANCHOR_Y = solveRipAnchor(pins.rip) ?? anchorOf(minY, maxY);
```

The solve, in the local frame:

```
sy = toLocal(frame, pin.seed).y
W  = clamp(pin.targetIn / 12, MIN, plankWidth)
h  = the outline height bounding the seed's row on the pinned side — greatest ≤ sy for
     edge 'low', least ≥ sy for edge 'high', over minY, maxY and
     outlineHeights([room, ...holes, ...clips])
ANCHOR_Y = mod(edge === 'low' ? h + W : h - W, plankWidth)
```

Everything it reads is already computed a few lines above. Ordering: after `room`/`holes`/`clips`
exist, before `firstRow`.

**`layoutProjection.ts`** — `pins: view.data.pins` in `layoutInputsOf`. **`store.ts`** — the write
helper.

**`ui/PlankInfoPanel.svelte`** — the Width row becomes a `LengthInput` when the board is ripped
(`ripped` is already computed there). Commit dispatches `setLayoutPins` with the seed taken as the
centroid of `plank.corners` and `edge` from which side of the board sits on a grid line rather
than on a boundary. Under it, the consequence, live: `4″ here → 3⅛″ at the far wall`.

**Test:** pin 4" where the natural first row is 2" — the first row measures 4", the far row
measures the complement, the plank count is unchanged or off by one. Then change the stock width
and assert the pinned row is _still_ 4". That second assertion is the one that justifies storing a
pin instead of writing the origin; without it this feature is a lookup table for origin drags.
Plus a codec round-trip and a `layoutKey` distinctness case.

### Phase 2 — the joint pin

Same skeleton, three new problems.

**The solve** runs after `ANCHOR_Y` is known. Scan a zero-height band at the seed's local `y` with
the helpers already imported — `bandIntervalsAt(room, sy, sy)`, intersected with `clips`,
subtracted against `holes` — take the run `[a, b]` containing the seed's `x`, and:

```
row = floor((sy - ANCHOR_Y) / plankWidth)
L   = clamp(pin.targetIn / 12, MIN_BOARD_FT, plankLength)
ANCHOR_X = mod((edge === 'low' ? a + L : b - L) - rowOffset(row, layout, plankLength), plankLength)
```

The stagger pattern is preserved exactly, because every row's grid is `ANCHOR_X + rowOffset(row)`
and this moves the shared term.

_Known approximation:_ a single scan line does not see the sub-band `breaks` the row loop applies
around a step, so a pin on the board beside an inside corner can solve against a slightly
different run. Covered by the post-check in phase 3 rather than by more machinery.

**`layRow` will fight the pin.** It already shifts the entire joint grid — and gives up a whole
board — to keep an end cut above `minEndCutIn`. Against an exact pin that is a silent override of
what the user typed. Thread a `locked` flag through `layAt`/`layRow` for the run containing the pin
seed, short-circuiting to `cutInterval`; other runs keep today's behaviour. The pin is an
instruction, the minimum is a default.

**`stagger: 'offcut'` has no shared phase.** Its offsets come from a search over off-cut
candidates, not from `ANCHOR_X`. For v1, disable the Length field under `offcut` with a one-line
hint that the off-cut rule is choosing the joints — honest and free. Later, the pinned row's
candidate list can be forced to `[pinned]` with rows above resuming the search.

### Phase 3 — feedback and honesty

**Post-check, in the engine.** After laying, find the plank containing each pin's seed and measure
it. Off target beyond tolerance → report it:

```ts
readonly pinsUnsatisfied?: readonly ('rip' | 'joint')[];
```

surfaced in the panel the way `truncated` and `narrow` already are. One mechanism covers every
approximation above _and_ the genuinely impossible pins — 60" off 48" stock, a room redrawn out
from under a seed — instead of each getting its own special case or, worse, none.

**Origin drag.** With a rip pin active, `ANCHOR_Y` no longer reads the origin, so dragging the
marker across the run does nothing visible. Dragging **clears** the corresponding pin, as its own
undo entry ("Clear pinned row width"). Direct manipulation winning is discoverable; a marker that
silently ignores the mouse is not.

**Visibility.** An accent on pinned boards in `PlankRenderer`, and pin chips with a clear button in
`FloorLayoutPanel`. A pin set five minutes ago must not become an invisible reason the floor will
not move.

## Risks

- **Two pins, one grid.** They are independent by construction — one is periodic in `plankWidth`
  across the run, the other in `plankLength` along it — and the phase-2 solve consumes the
  phase-1 answer rather than racing it. Worth an explicit test that setting both leaves both
  satisfied, because that independence is an argument and not a proof.
- **Seed drift.** A seed survives a wall drag; a seed whose row is _deleted_ by one resolves to
  the nearest outline height instead and silently pins a different row. The post-check catches the
  case where the result is wrong; it cannot catch the case where the result is merely surprising.
  If that shows up in use, the fix is to drop a pin whose seed leaves the room outline, not to
  make the resolution cleverer.
- **`MAX_PLANKS` and the row count.** A rip pin shifts the grid by less than one board, so it can
  add at most one row. Nothing here can grow the floor unboundedly.
