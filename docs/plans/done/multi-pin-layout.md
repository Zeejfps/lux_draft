# Multi-Pin Layout Plan

**Status:** built
**Created:** 2026-08-03
**Supersedes:** the "exactly two degrees of freedom" claim in `done/layout-pins.md`
**Touches:** `../../../src/modules/flooring/types.ts`, `codec.ts`, `commands.ts`,
`PlankLayoutEngine.ts`, `store.ts`, `ui/PlankInfoPanel.svelte`, `ui/FloorLayoutPanel.svelte`,
`../../../tests/unit/modules/plankLayoutEngine.test.ts`

## Goal

Pin as many boards to as many sizes as the room can physically hold, and have the layout work the
rest out. Pin the row against each wall, the row against the island, and the end piece of three
different rows, and get a floor that honours all of them.

## What was wrong before

`done/layout-pins.md` argued that a floor has exactly two degrees of freedom — one phase across the
run, one along it — and built one pin of each. The argument is sound **given a uniform row grid**,
and the uniform row grid is an assumption in `PlankLayoutEngine`, not a property of a floor. The
plan's own table ("what pays for it") is the tell: it reads as physics and is actually bookkeeping
for a single global `ANCHOR_Y`.

An installer rips whatever rows they need to. Two rows of different widths in one room costs
material and a second saw setting; it does not cost feasibility. The same goes along the run: the
shared `ANCHOR_X + rowOffset(row)` is a **stylistic** rule about how joints stagger, not a
constraint — a row whose end piece was set to a particular length simply departs from the formula,
which is what happens on site.

So the limit was ours. This replaces it.

## Decision

**Pins partition the run into segments.** One anchor becomes a sequence of row edges.

Today the row grid is `ANCHOR_Y + k · plankWidth`, one scalar for the floor. Instead the engine
builds an explicit, monotone list of **row edges** spanning `[minY, maxY]`, and the bands are cut at
those. With no pins the list _is_ the arithmetic grid, so an unpinned floor is unchanged — not
equivalent, identical, and the existing tests are the proof obligation.

With rip pins:

1. Each pin resolves to a forced interval `[b, b+W]` (or `[b-W, b]`), where `b` is the outline
   height the board is measured from — the same resolution `solveRip` already does.
2. The forced intervals are sorted and the run is swept low to high.
3. Each gap between them is filled with full-width rows from its **low** end, and whatever is left
   over is one ripped **make-up row** at its high end — which is the board an installer cuts when
   they run out of room before the next thing they are laying to.

`N` pins therefore cost up to `N` make-up rows, and every pin is satisfiable as long as each gap can
hold one. That is the whole model; there is no solver, because a partition of an interval is not a
constraint system.

Along the run, a joint pin becomes a **per-row override**: the row holding the pin is laid on the
grid the pin names and its run is locked against `layRow`'s minimum-end-cut shift, exactly as now.
Rows with no pin keep today's behaviour.

One wrinkle worth naming: with a single joint pin, moving the **shared** anchor is nicer than
overriding one row, because it slides the whole floor and the stagger pattern survives intact. So
the lowest joint pin sets `ANCHOR_X` as it does today, and every _additional_ joint pin is a per-row
override. One pin behaves exactly as it does now; two or more degrade a row at a time rather than
all at once.

### Why rip pins anchor to an outline height

A pin on a _middle_ row would be circular — the row's position depends on every row beneath it, so
"the row containing this seed" moves as soon as the pin is applied. It is also not a thing anyone
needs: a middle row is a full board, and `PlankInfoPanel` only offers the field on a board that was
ripped. So a rip pin is always measured from a real boundary — a wall, an obstacle edge, a region
edge — and that is what makes the sweep well-founded rather than iterative.

This tightens `Plank.ripEdge`, which currently means "the edge not on the row grid". It should mean
"the edge that lies on an outline height", which is the question `solveRip` can actually answer. The
two agree today and stop agreeing the moment a make-up row exists — a make-up row is ripped, has no
boundary on either side, and would otherwise offer a pin that resolves against the wrong wall.

### Conflicts are refused where they are made

A pin set is always satisfiable when it is stored. `PlankLayout.pinSlots` reports where every pin
landed and what refused it, the store runs the engine against the **proposed** set, and a pin that
would not fit is never dispatched — the panel says what stopped it.

The plan called for factoring the geometry prep out so a cheap checker could share it. That is not
what was built: `pinSlots` rides on the layout `computePlankLayout` already produces, and the store
runs a whole layout to read it. One layout on a keystroke the user has already committed to is not
worth a refactor of the engine's most delicate section, and it keeps a single implementation of
where a pin goes rather than two that can drift.

Only **deterministic** impossibilities are refused: a size no board of the stock could be, a row
already pinned, a forced row overlapping another, a seed with no boundary left to measure from. A
pin that merely _misses_ — the single-scan-line approximation beside an inside corner — is stored
and reported, because rejecting a user's number over an approximation is worse than laying it and
saying so.

`pinsUnsatisfied` **stays**. Refusal cannot be the whole answer: a set that was satisfiable when it
was made is invalidated by the next wall drag, and nothing prunes the document when geometry moves.
Refusal keeps the _authoring_ honest; the post-check keeps the _floor_ honest.

## Rejected

- **A constraint solver.** Still not needed. Sorted intervals over one axis and a per-row override
  over the other is a sweep, and a sweep reports its own conflicts for free.
- **Pinning a middle row.** Circular to resolve and useless to have (above).
- **Dropping `pinsUnsatisfied` now that pins are checked on the way in.** Geometry moves under
  stored pins; see above.
- **Renumbering rows from zero.** `rowOffset` is a function of the row index, so renumbering
  silently restaggers every existing floor. Row `i` keeps the number `firstRow + i` it has today.
- **Bumping the schema version.** The singular `rip` / `joint` keys are read into the lists, so a
  document written against the one-pin build still decodes. A bump would make new documents
  unreadable by older builds, which is the direction that actually hurts.

## Phases

All four are built.

### Phase 1 — the row edge list

`buildRowEdges` replacing the `ANCHOR_Y + k · plankWidth` set, with **no pins** wired in. The
acceptance criterion was that the whole existing suite pass untouched, because the zero-pin case
must be the same floor. It did, on the first run — 819 tests, no fixture moved.

### Phase 2 — many rip pins

`pins.rips`, the sweep, the make-up rows, `ripEdge` retightened to outline heights.

One thing the plan did not anticipate: **where the make-up row goes depends on the segment.** Below
the first pinned row the low end is a wall, so the fill is phased off the pin above and the leftover
lands against that wall under the trim — which is where a single pin has always put it. Between two
pinned rows there is no wall to favour, so boards go down full from below and the make-up sits
against the next pin, in the order they are laid. Filling every segment the same way would have
moved the leftover of a one-pin floor off the wall and into the middle of the room.

### Phase 3 — many joint pins

`pins.joints`, per-row overrides, the lowest pin keeping the shared anchor.

### Phase 4 — refusal, and the panels

`pinSlots`, the store's pre-flight, the chips listing every pin rather than two.

## Risks

- **The zero-pin floor must not move.** Mitigated by doing phase 1 alone against the existing suite.
  If a single fixture shifts, the edge list is wrong and nothing after it is worth building.
- **Make-up rows are new boards.** A floor with four pins can carry four extra ripped rows, each of
  which is waste and may trip `minRipWidthIn`. That is the honest cost of asking for four sizes and
  it belongs in the cut list and the narrow-board count, both of which already report it.
- **Seed drift, multiplied.** Every pin is anchored to a seed and a boundary, and a wall drag can
  move the boundary out from under several at once. The post-check reports each independently.
