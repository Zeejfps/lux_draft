# Plank Boundary Cuts Plan

**Status:** proposed
**Created:** 2026-08-02
**Touches:** `src/modules/flooring/PlankLayoutEngine.ts`, `PlankIndex.ts`,
`rendering/PlankRenderer.ts`, `ui/CutListPanel.svelte`, `tests/unit/modules/plankLayoutEngine.test.ts`

## Goal

Cut every board to the boundary it meets, so the expansion gap is the same distance from every
wall whatever angle that wall or the run is at.

## The defect

`computePlankLayout` samples each row on **one** scan line at the band's centreline and emits the
piece as an **axis-aligned rectangle** in the run frame. Where the boundary is not parallel or
perpendicular to the run, the rectangle's corners are wherever the centreline said they were: half
the board hangs past the wall and the other half leaves a wedge of bare subfloor. The engine's
header names this approximation and bounds it at one plank width; the bound is real, and one plank
width is ±3.5" against a 3" gap.

Measured — 12 x 10 room, 7" x 48" plank, 3" gap, minimum clearance from any plank corner to a wall:

| case                                | min clearance |
| ----------------------------------- | ------------- |
| run 0°                              | 3.000 in      |
| run 90°                             | 3.000 in      |
| run 45°                             | 0.525 in      |
| run 30°                             | **−0.031 in** |
| run 15°                             | **−0.381 in** |
| run 0°, room with one diagonal wall | 0.311 in      |

Negative is outside the room. Note that a rotated run makes _every_ wall diagonal in the run frame,
so this is not an edge case reserved for oddly shaped rooms — it is every floor laid at 45°.

## Decision

Keep the scan-line row model. It is the right shape for a cut list, it is what keeps the stagger
and the joint grid continuous, and it handles a concave room that a convex clip cannot. Change two
things underneath it:

1. **Split bands at every vertex height**, so that within one band every boundary edge is a single
   straight line and each span's ends are therefore _linear_ in y.
2. **Emit a quad, not a rectangle.** With linear span ends, the exact shape of the piece against
   the boundary is a trapezoid — the interior planks stay rectangles and only the first and last
   piece of each span gains a slanted end.

That is exact for straight-edged geometry, which is all this editor can draw. Nothing is left
approximate: no residual half-plank error, no under-reported square footage.

Rejected: clipping each plank quad against the room with a general polygon boolean. It would give
the same answer for these inputs at the cost of a clipper the module does not otherwise need, and
it loses the piece's identity as a _board_ — the cut list wants a length along the run and two end
cuts, not an arbitrary polygon.

## Phases

Each phase is shippable on its own and leaves the tests green.

### Phase 1 — bands split at every vertex height

Engine only; no output shape change, no renderer change.

`boundaries` (`PlankLayoutEngine.ts`, the `bandEdges` set) currently holds the row grid, the room's
`minY`/`maxY` and the region transition heights. Add every local-frame vertex y of the room, of
each hole, and of each clip ring. Bands are already indexed back to their row for stagger, so a
band split by a vertex keeps its joints — the machinery is there.

Buys on its own: the rip against the _inside step of an L_ and against every obstacle corner
becomes exact, and `coveredSqft` stops under-reporting. A diagonal wall is still wrong, but its
error drops from one plank width to one band height.

Cost: more bands. A room with 8 vertices adds at most 8 bands to a floor of ~30, and each band is
one scan line.

**Test:** the L-shaped 300 sqft room reports 300.0, not 299.2.

### Phase 2 — trapezoid spans in the engine

Replace `intervalsAt(room, centreY)` with a span whose ends are known at both band edges. Within a
band no edge starts or ends, so the crossing that produced an interval endpoint at the centreline
produces the endpoint at `bandLow` and `bandHigh` on the same edge — compute all three, or compute
the two edges and interpolate. Same for the clip intersection and the hole subtraction, which need
their interval algebra done on _pairs_ of endpoints (low, high) rather than on scalars.

`Plank` becomes:

```ts
export interface Plank {
  readonly id: string;
  readonly row: number;
  readonly column: number;
  readonly center: Vector2; // unchanged: centre of the nominal board
  readonly length: number; // long point, along run
  readonly width: number; // across run
  /** World-space corners, run-frame order. A rectangle unless an end was cut to the boundary. */
  readonly corners: readonly [Vector2, Vector2, Vector2, Vector2];
  readonly cut: boolean;
}
```

`length`/`width` stay the nominal board the purchase model buys, so `purchaseSimulation` and
`MIN_USABLE_OFFCUT_FT` are untouched; `coveredSqft` becomes the trapezoid's area.

Guard: an edge within `FLAT_EPS` of horizontal in the run frame would give an unbounded slant.
Phase 1's split puts a band edge there, so such an edge cannot be interior to a band — assert it
rather than clamp it.

**Test:** the clearance table above, as a property — for run angles 0…90 in 5° steps, and for a
room with two diagonal walls, every plank corner sits between `gap` and `gap + plankLength` from
the boundary. This is the test that fails today.

### Phase 3 — the renderer

`PlankRenderer` draws one `InstancedMesh` of a 1x1 `PlaneGeometry`, which cannot represent a
sheared quad. Two routes; recommend the first.

- **Per-instance shear (recommended).** Add two floats per instance — the along-run offset of the
  start end and of the end end, top edge relative to bottom — as an `InstancedBufferAttribute`, and
  displace `position.x` by `mix(slantLow, slantHigh, uv.y)` in a vertex-shader chunk injected with
  `material.onBeforeCompile`. Keeps one draw call, one geometry, the existing growth-only buffer
  policy and the hover path exactly as they are. ~40 lines.
- **Merged geometry (fallback).** Build one `BufferGeometry` of 4 vertices per plank per layout.
  Simpler to read, no shader, but it rebuilds ~3k vertices per settled frame and hover becomes a
  vertex-colour write rather than an instance-colour write. Fine at these sizes; it just gives back
  the property the renderer's header defends.

The seam inset (`SEAM_FT`) applies to the nominal rectangle in both routes.

### Phase 4 — hit testing

`PlankIndex.contains` is point-in-rectangle in the plank's own frame. With a quad, test the point
against the four half-planes of `corners`. The grid cells are already sized by the longest
dimension, and a sheared quad's bounding box is what `corners` gives directly.

### Phase 5 — the cut list

A piece cut against a diagonal wall has a long point, a short point and an angle, and an installer
needs all three to set a saw. `CutListEntry` gains `shortIn` and `angleDeg`, both absent for a
square cut, and `CutListPanel` renders `48 in` or `48 → 41 1/2 in @ 22°`. Grouping still rounds to
the nearest 1/8 in; the angle rounds to the nearest degree.

### Phase 6 — documentation

The engine's header comment currently documents the centreline approximation as a deliberate,
bounded trade. Rewrite that section: what remains approximate afterwards is nothing for
straight-edged input, and the reason the scan line survived is the cut list, not the geometry.

## Risks

- **Interval algebra on pairs.** `subtractIntervals`/`intersectIntervals`/`unionIntervals` in
  `geometry2d.ts` are shared with `RegionSolver`. Add a parallel set over
  `{ low: [number, number], high: [number, number] }` rather than generalising the existing ones,
  so the solver's use is untouched.
- **Band count.** Bounded by (rows + vertices), and each band is one scan line. Measure before and
  after on the 900 sqft great room fixture; `MAX_PLANKS` is unaffected because it counts pieces.
- **A quad is not a board.** Where two diagonal walls meet, one piece can end up a triangle. That
  is what actually gets installed, and it should appear in the cut list as such rather than being
  rounded to a rectangle.
