import type { Obstacle, Vector2, WallSegment } from '../../floorplan/types/geometry';
import type { LayoutConfig, PlankSpec, StartCorner } from './types';
import { INCHES_PER_FOOT, MAX_PLANKS } from './types';
import type { BandPoint, BandSpan, Interval } from './geometry2d';
import {
  EPS,
  bandIntervalsAt,
  bandMid,
  intersectBandSpans,
  signedArea,
  subtractBandSpans,
  unionBandSpans,
  unionIntervals,
} from './geometry2d';

/**
 * `PlankLayoutEngine` — a **pure** function of (boundary, obstacles, plank, layout, origin) to
 * planks, a cut list and a waste percentage.
 *
 * Nothing here reads a store, a document, a session or a selection, and nothing here is stored
 * (invariant 5): there is no field for a layout on `FlooringData`, no persistence API accepts
 * one, and the codec round-trip test asserts the persisted shape. Store the config, derive the
 * floor — which also gives correct undo granularity for free, stepping through user intent
 * rather than machine output.
 *
 * It is also free of `three` and of `svelte`, which is what makes it testable as a table and
 * what makes moving it into a worker a change confined to `layoutProjection.ts`.
 *
 * ## Method
 *
 * Rows are laid in a **run-aligned frame**: the room is rotated by `-runAngleDeg` about the
 * layout origin and then mirrored so that the configured start corner is always the local
 * bottom-left. From there the run is always `+x` and rows always stack in `+y`, so the four
 * start corners and every run angle collapse into one code path and one set of tests.
 *
 * Within that frame each row is a horizontal band. The engine scans the band against the room
 * polygon to get the spans that are inside the room, subtracts the same scan against every
 * obstacle polygon, and lays planks along what is left. A scan rather than a polygon boolean
 * because the room is frequently concave (an L-shaped kitchen) and Sutherland–Hodgman clipping
 * is only correct against a convex clip region — and because a cut list wants piece *lengths*
 * along the run, which is exactly what a span gives.
 *
 * When `regions` is given the same scan is also intersected with the areas assigned to this
 * floor, so the run stops where the LVP stops and the carpet begins. Bands are still *indexed*
 * against the room's row grid, which is what keeps the stagger pattern and the joint grid
 * continuous across a transition instead of restarting on the far side of it.
 *
 * ## Why bands break at every vertex
 *
 * `bandEdges` is the row grid **plus every height at which the outline turns** — the room's, an
 * obstacle's, an area's. Two things depend on it.
 *
 * The first is that no band may straddle a boundary that runs *along* the rows. Sampled on one
 * line and laid whole, such a band either crosses the boundary or, if the sample lands the other
 * side of it, is dropped and leaves bare subfloor; which of the two happens depends on where the
 * grid falls, and the grid is anchored at the layout origin, so dragging the origin marker swung
 * the floor's edge either side of a transition — and let a board straddling the inside corner of
 * an L hang half of itself over the part of the room that is not there.
 *
 * The second is that within a band, no polygon edge starts or ends. Every span's endpoint
 * therefore travels along a single straight edge and is **linear in y**, which is what lets the
 * scan report the span at *both* band edges rather than at a centreline, and what makes the
 * piece against a diagonal boundary an exact trapezoid (`Plank.corners`) rather than a rectangle
 * placed where the centreline happened to say.
 *
 * Sub-bands of one row keep that row's index, so they share its stagger offset and its joint
 * grid; a boundary cuts a row's width, never its rhythm.
 *
 * ## Why the sub-bands are then knitted back together
 *
 * A vertex changes the boundary only at *its own x*, but the split runs the whole width of the
 * room. Emitted straight out, one room corner therefore rips every board in its row from wall to
 * wall — a seam fixed in world space, immune to the plank width and to the layout origin, which
 * is how it gets noticed. So each piece is held open across its row's sub-bands and closed only
 * where the boundary actually moved on it; see `Cell` and `extend`. The board beyond the inside
 * step of an L, which has nothing above it to join, is still ripped — that rip is the room.
 *
 * The distinction the join turns on is **step** against **bend**. A boundary that steps leaves
 * the two pieces' ends in different places, and no single board can reach across it without
 * being L-shaped; that is two boards. A boundary that merely bends — a diagonal transition
 * running into a wall — leaves them meeting at the same point and takes a corner off one whole
 * board, which is one piece of stock with two cuts on one end. So a board's end is a *profile*
 * across its width rather than a single cut, `Plank.corners` is a polygon rather than four
 * points, and `collapseStraight` drops the profile point again wherever the end did not really
 * bend, leaving the ordinary board at four corners.
 *
 * ## What is left approximate
 *
 * For straight-edged geometry — which is all this editor can draw — nothing. Every piece is cut
 * to the boundary it meets, so the expansion gap is the same distance from every wall whatever
 * angle that wall or the run is at, and `coveredSqft` is the area actually laid rather than a
 * count of whole rectangles. What survived from the older scan-line design is the **row model**,
 * and it survived for the cut list rather than for the geometry: a board is a length along the
 * run with a cut at each end, and that is what an installer sets a saw from. A general polygon
 * clip would give the same answer for these inputs while losing the piece's identity as a board.
 */

// ============================================
// Inputs and outputs
// ============================================

/**
 * The **narrow inputs** the projection requirement names. Note what is absent: no `Session`, no
 * `EditorDocument`, no `ModuleView`, no selection, no display preferences, no view mode. A
 * selection change cannot invalidate a layout because a selection is not reachable from here.
 */
export interface LayoutInputs {
  readonly walls: readonly WallSegment[];
  readonly isClosed: boolean;
  readonly obstacles: readonly Obstacle[];
  readonly plank: PlankSpec;
  readonly layout: LayoutConfig;
  readonly origin: Vector2;
  /**
   * The areas to lay plank over, from `RegionSolver`. `null` means the whole room — which is
   * what a document with no dividers produces, so the pre-divider floor comes out identical
   * rather than merely equivalent. An **empty array** means every area was assigned to another
   * surface and no plank is laid; it is not the same thing as `null`.
   *
   * Rings are world-space and need not be disjoint; overlaps are unioned per row.
   */
  readonly regions?: readonly (readonly Vector2[])[] | null;
}

export interface Plank {
  readonly id: string;
  readonly row: number;
  readonly column: number;
  /** World-space centre of the **nominal** board — the rectangle before its ends were cut. */
  readonly center: Vector2;
  /** Along-run extent, feet. The long point where an end is mitred. */
  readonly length: number;
  /** Across-run width, feet. Less than the plank width when the row is ripped at a wall. */
  readonly width: number;
  /**
   * The board's outline, world space, as a simple polygon.
   *
   * **Order.** A board is `k` profile points across its width, low edge to high — see
   * `plankProfile` — and the ring walks `start@0`, then the end side upward `end@0 … end@k-1`,
   * then `start@k-1` and back down the start side `start@k-2 … start@1`. For the usual board
   * `k` is 2 and this is the four corners `(start, low)`, `(end, low)`, `(end, high)`,
   * `(start, high)`: a rectangle of `length` x `width` about `center`, or a trapezoid where an
   * end was cut to a boundary not square to the run. Where two such boundaries meet it can
   * collapse to a triangle — two corners coincide, which is the piece that gets installed there.
   *
   * `k` exceeds 2 when a boundary **bends** across the board rather than stepping: a diagonal
   * transition meeting a wall clips a corner off an otherwise whole board, and the outline is
   * then a pentagon. That is one board with two cuts on one end, not two boards, and the
   * distinction is worth the general polygon — a corner clipped at a transition used to come out
   * as a 7" board ripped into a 2 7/8" strip and a 4 1/8" strip, both full length, both bought.
   */
  readonly corners: readonly Vector2[];
  /** True when the piece was cut — shorter than a full plank, ripped narrower, or mitred. */
  readonly cut: boolean;
  /**
   * True when `width` is below the plank's `minRipWidthIn` — a sliver.
   *
   * Advisory. The board is laid exactly where it would be anyway; this only marks it, so the
   * renderer can colour it and the panels can count it. See `PlankSpec.minRipWidthIn` for why the
   * engine flags rather than fixes.
   */
  readonly narrow: boolean;
}

/**
 * A board's ends across its width: `[start, end]` at each profile point, low edge to high.
 *
 * The inverse of the ring `Plank.corners` is built as, and the form anything drawing or measuring
 * a board wants — consecutive entries bound one quad, so a renderer that can draw a sheared quad
 * can draw any board by walking these in pairs. Two entries for the ordinary board; more only
 * where a boundary bends across it.
 *
 * Derived rather than stored so the outline stays the single geometric truth: two representations
 * of one shape is two things to keep in step, and the polygon is the one every other consumer —
 * hit-testing, area, export — actually needs.
 */
export function plankProfile(plank: Plank): readonly (readonly [Vector2, Vector2])[] {
  const ring = plank.corners;
  const points = ring.length / 2;
  const out: [Vector2, Vector2][] = [];
  for (let i = 0; i < points; i++) {
    // `start` runs backwards from the end of the ring, except its two extremes: index 0 is the
    // low edge, and the high edge sits just past the end side rather than at the ring's tail.
    const start = i === 0 ? ring[0] : i === points - 1 ? ring[points + 1] : ring[ring.length - i];
    out.push([start, ring[1 + i]]);
  }
  return out;
}

/** One line of the cut list: "14 pieces at 23 1/2 in", or "3 at 48 → 41 1/2 in @ 22°". */
export interface CutListEntry {
  /**
   * What makes this line its own line: every figure below it, in one string.
   *
   * Carried rather than left to the reader to rebuild, because a list keyed on a subset of what
   * distinguishes its rows silently merges two of them — and the panel keys its `{#each}` on
   * exactly this, so a subset would be a duplicate key and a render error rather than a quiet
   * wrong number. There is one place the grouping is decided, and this is it.
   */
  readonly key: string;
  /** Long point, rounded to the nearest 1/8 in — the finest mark on a tape measure. */
  readonly lengthIn: number;
  /**
   * Short point, when an end was cut to a diagonal boundary. Absent for a square cut, because an
   * installer setting a saw needs a long point, a short point and an angle, and a square cut has
   * only the first of the three.
   */
  readonly shortIn?: number;
  /** The mitre off square, degrees, rounded to the nearest whole one. Absent for a square cut. */
  readonly angleDeg?: number;
  /**
   * Finished width, inches, when the board was **ripped** narrower than the plank's face. Absent
   * at full width, where saying so on every line would bury the lines where it is the point.
   *
   * A rip is the second setting a cut list has to carry. Grouped by length alone, the last row's
   * boards merge into the line for the full-width boards that happen to be the same length — six
   * pieces at 32", five of them 7" wide and one ripped to 5 5/16" — and the list sends an
   * installer to the saw with one setting for two different boards.
   */
  readonly ripWidthIn?: number;
  readonly count: number;
}

export interface PlankLayout {
  /** The structural key of the inputs this was computed from. */
  readonly key: string;
  readonly planks: readonly Plank[];
  readonly cutList: readonly CutListEntry[];
  /** Run angle in radians, world space. Every plank shares it. */
  readonly angle: number;
  readonly fullPieces: number;
  readonly cutPieces: number;
  /** Boards that must actually be bought, after re-using off-cuts. */
  readonly purchasedPlanks: number;
  readonly coveredSqft: number;
  readonly purchasedSqft: number;
  readonly wastePercent: number;
  /** How many boards came out below `PlankSpec.minRipWidthIn`. */
  readonly narrowPieces: number;
  /**
   * The narrowest board on the floor, inches — `null` when nothing was ripped at all.
   *
   * Reported whether or not it trips the minimum, because the useful thing to say next to the
   * count is *how* narrow, and a floor sitting just inside the limit is the one where nudging the
   * origin is worth it.
   */
  readonly narrowestRipIn: number | null;
  /** True when `MAX_PLANKS` stopped the run; the figures below it are then a floor, not a total. */
  readonly truncated: boolean;
}

export const EMPTY_LAYOUT: PlankLayout = {
  key: '',
  planks: [],
  cutList: [],
  angle: 0,
  fullPieces: 0,
  cutPieces: 0,
  purchasedPlanks: 0,
  coveredSqft: 0,
  purchasedSqft: 0,
  wastePercent: 0,
  narrowPieces: 0,
  narrowestRipIn: null,
  truncated: false,
};

// ============================================
// The structural key
// ============================================

/**
 * A key over exactly the inputs the layout depends on.
 *
 * It is what makes the cache a **hit** rather than a recompute when the user undoes past a
 * config change and back: the same inputs produce the same string, whichever route the document
 * took to get there. It is deliberately the full canonical form rather than a hash — a hash
 * collision here would silently render the wrong floor, and a room has tens of vertices, not
 * thousands.
 */
export function layoutKey(inputs: LayoutInputs): string {
  if (!inputs.isClosed || inputs.walls.length < 3) return 'open';
  const n = (v: number): string => (Math.round(v * 1e6) / 1e6).toString();
  const poly = (walls: readonly WallSegment[]): string =>
    walls.map((w) => `${n(w.start.x)},${n(w.start.y)}`).join(' ');
  const { plank, layout, origin } = inputs;
  const ring = (points: readonly Vector2[]): string =>
    points.map((p) => `${n(p.x)},${n(p.y)}`).join(' ');
  return [
    poly(inputs.walls),
    inputs.obstacles.map((o) => poly(o.walls)).join('|'),
    // `null` is the unrestricted case and must key identically to a document written before
    // regions existed, so it contributes a fixed token rather than the room's own ring.
    inputs.regions == null ? 'all' : inputs.regions.map(ring).join('|'),
    // The rip minimum is in the key even though it moves no geometry: it decides `Plank.narrow`
    // and the two summary figures, so a layout cached under the old value would come back with
    // the wrong boards flagged.
    `${n(plank.widthIn)}x${n(plank.lengthIn)}@${n(plank.minRipWidthIn)}`,
    [
      n(layout.runAngleDeg),
      layout.startCorner,
      layout.stagger,
      n(layout.minEndCutIn),
      n(layout.expansionGapIn),
      layout.rowOffsetPattern.map(n).join(','),
      layout.seed,
    ].join('/'),
    `${n(origin.x)},${n(origin.y)}`,
  ].join(';');
}

// ============================================
// The run-aligned frame
// ============================================

/** Signs that map the configured start corner onto the local bottom-left. */
function cornerSigns(corner: StartCorner): { sx: number; sy: number } {
  return {
    sx: corner === 'bottomRight' || corner === 'topRight' ? -1 : 1,
    sy: corner === 'topLeft' || corner === 'topRight' ? -1 : 1,
  };
}

interface Frame {
  readonly cos: number;
  readonly sin: number;
  readonly sx: number;
  readonly sy: number;
  readonly origin: Vector2;
}

function toLocal(frame: Frame, p: Vector2): Vector2 {
  const dx = p.x - frame.origin.x;
  const dy = p.y - frame.origin.y;
  return {
    x: frame.sx * (dx * frame.cos + dy * frame.sin),
    y: frame.sy * (-dx * frame.sin + dy * frame.cos),
  };
}

function toWorld(frame: Frame, p: Vector2): Vector2 {
  const lx = frame.sx * p.x;
  const ly = frame.sy * p.y;
  return {
    x: frame.origin.x + lx * frame.cos - ly * frame.sin,
    y: frame.origin.y + lx * frame.sin + ly * frame.cos,
  };
}

// ============================================
// The expansion gap
// ============================================

/**
 * Why the mitre is **not** capped.
 *
 * It used to be, at four gaps, to stop a vertex shooting off toward infinity as a corner
 * approaches a spike. But the inward mitre's reach is `distance / sin(θ/2)` for an interior angle
 * θ, so a cap at four gaps fires for every corner sharper than **29°** — and what it does there
 * is drag the vertex back toward the corner, leaving it `4 · gap · sin(θ/2)` from the two walls
 * that meet at it instead of `gap`. At 8° that is a thirteenth of an inch where a quarter inch
 * was asked for, and the boards laid into the corner creep toward the wall as it narrows, which
 * is exactly what a floor buckling at a transition looks like on the drawing.
 *
 * There is no cap that avoids this. The mitre point is the intersection of the two offset lines,
 * and that intersection *is* the set of points a gap away from both edges: pull it in by any
 * amount and one of the two gaps closes by the same amount. So the reach is left alone, and the
 * two checks below — no edge may come out running backwards, and the winding may not flip — are
 * what catch a corner sharp enough to consume the feature. They are the honest test, because they
 * ask whether there is any floor left rather than guessing a distance at which there is not.
 *
 * A spike thin enough to reverse an edge needs an interior angle under about a degree at these
 * dimensions, which is a room this editor cannot draw on purpose.
 */

/**
 * The polygon pulled inward by `distance`; a negative distance pushes it outward, which is what
 * an obstacle wants. Returns `[]` when the inset consumes the region.
 *
 * This is how the expansion gap is applied, and it is applied here rather than by trimming each
 * scan-line interval because the gap is a distance from **every** wall. Trimming the interval
 * only backs the planks off the two walls their ends butt into; the two walls the run is
 * parallel to would get nothing, and a floating floor with no gap on one axis buckles on that
 * axis. Moving each edge along its own normal also measures the gap perpendicular to a diagonal
 * wall, where trimming an interval horizontally would have left `gap / cos θ`.
 *
 * Winding is detected, not assumed: `toLocal` mirrors for two of the four start corners, which
 * reverses it.
 *
 * Joins are mitred, and the mitre is **exact at every angle** — see `MAX_MITER`'s epitaph above
 * for why capping it was a quiet way of not holding the gap at any corner sharper than 29°. A
 * distance large enough to collapse a narrow feature can still self-intersect; with a gap of an
 * inch or two against walls measured in feet that needs a room this editor cannot draw, and the
 * scan line's even-odd rule degrades to dropping the inverted lobe rather than to nonsense.
 */
function insetPolygon(polygon: readonly Vector2[], distance: number): Vector2[] {
  const n = polygon.length;
  if (n < 3) return [];
  if (Math.abs(distance) <= EPS) return [...polygon];

  const area = signedArea(polygon);
  if (Math.abs(area) <= EPS) return [];
  const inward = area > 0 ? 1 : -1;

  // Unit inward normal of the edge leaving each vertex.
  const normals: Vector2[] = [];
  for (let i = 0; i < n; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    normals.push(len <= EPS ? { x: 0, y: 0 } : { x: (-dy / len) * inward, y: (dx / len) * inward });
  }

  const out: Vector2[] = [];
  for (let i = 0; i < n; i++) {
    const before = normals[(i + n - 1) % n];
    const after = normals[i];
    const p = polygon[i];

    // The mitre vector `(n1 + n2) / (1 + n1·n2)` has a projection of exactly 1 onto each
    // normal, so both edges end up `distance` from where they were.
    const denom = 1 + (before.x * after.x + before.y * after.y);
    if (denom <= EPS) {
      // The edges double back on each other; there is no mitre, so take one normal.
      out.push({ x: p.x + after.x * distance, y: p.y + after.y * distance });
      continue;
    }
    const scale = distance / denom;
    const ox = (before.x + after.x) * scale;
    const oy = (before.y + after.y) * scale;
    // A corner sharp enough to overflow a double has already failed the `denom` test above, but
    // the offset is what every later stage divides by, so it is checked where it is made.
    if (!Number.isFinite(ox) || !Number.isFinite(oy)) return [];
    out.push({ x: p.x + ox, y: p.y + oy });
  }

  // Inset past the middle and an edge comes out running backwards: the two walls it separated
  // have crossed, and what is left is not a smaller room but no room. Winding does not catch
  // this — a square inset by its own width lands on itself, reversed edge by edge, with the
  // same area and the same sign — so the test is per edge, against the edge it came from.
  for (let i = 0; i < n; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % n];
    const a2 = out[i];
    const b2 = out[(i + 1) % n];
    if ((b.x - a.x) * (b2.x - a2.x) + (b.y - a.y) * (b2.y - a2.y) < -EPS) return [];
  }
  const insetArea = signedArea(out);
  if (insetArea * area <= EPS) return [];
  return out;
}

// ============================================
// Stagger
// ============================================

function mod(value: number, m: number): number {
  return ((value % m) + m) % m;
}

/** Deterministic in `(seed, row)`, so `random` stagger is still a pure function of the config. */
function hashFraction(seed: number, row: number): number {
  let h = (Math.trunc(seed) ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (row + 0x85ebca6b), 0xcc9e2d51) >>> 0;
  h = Math.imul((h << 15) | (h >>> 17), 0x1b873593) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function rowOffset(row: number, config: LayoutConfig, plankLength: number): number {
  switch (config.stagger) {
    case 'none':
      return 0;
    case 'half':
      return mod(row, 2) * (plankLength / 2);
    case 'thirds':
      return mod(row, 3) * (plankLength / 3);
    case 'pattern': {
      const pattern = config.rowOffsetPattern;
      if (pattern.length === 0) return 0;
      return mod(pattern[mod(row, pattern.length)], 1) * plankLength;
    }
    case 'random':
      return hashFraction(config.seed, row) * plankLength;
  }
}

// ============================================
// Laying one row
// ============================================

interface Piece {
  readonly start: number;
  readonly end: number;
}

/**
 * One board, while it is still being assembled.
 *
 * A row is cut into sub-bands at every height an outline turns, so that the geometry within each
 * is exact — but a vertex changes the boundary only at *its own x*, and the split runs the whole
 * width of the room. Laid straight out, one room corner therefore rips every board in its row
 * from wall to wall: a seam fixed in world space, immune to the plank width and to the layout
 * origin, which is exactly how it gets noticed.
 *
 * So a piece is held open across the sub-bands of its row and closed only when the boundary
 * actually changes on it — see `extend`. The rip survives where it is real (the board beyond the
 * inside step of an L, which has nothing above it to join) and disappears where it never was.
 */
interface Cell {
  /**
   * The nominal x interval — the board's **long point** at each end, which is what the cut list
   * is measured against and how much stock the cut consumes.
   *
   * Not fixed, and not a test of whether two pieces are the same board. A bend moves the long
   * point: the sub-band a board's end meets square reaches further along the run than the one the
   * diagonal cuts, so the two halves of one board disagree about it by exactly the depth of the
   * corner being taken off. Joining takes the union, which is the long point of the whole board.
   */
  start: number;
  end: number;
  startsRun: boolean;
  /** The band edges this board spans, ascending. Its low edge first, its high edge last. */
  edges: number[];
  /** The start end's x at each of `edges` — the board's end profile, not a single cut. */
  startXs: number[];
  endXs: number[];
}

/**
 * How far two sub-bands' ends may disagree and still be one board, in feet.
 *
 * Well under a thousandth of an inch: when the same polygon edge produced both, they agree to
 * rounding, and when two different edges did, a room this editor can draw puts them further
 * apart than this.
 */
const JOIN_TOL = 1e-7;

/**
 * Drop the last profile point when the boundary did not actually turn on it.
 *
 * The sub-band split is an artefact of the *room's* vertices, not of this board's ends: a corner
 * at the far side of the room breaks every row at its own height, and a board nowhere near it
 * sees three collinear profile points where it has one straight cut. Left in, the board is a
 * polygon carrying a redundant vertex, its cut list gains a bend of zero degrees, and the
 * renderer draws two quads where there is one. So a joint survives only where the end really
 * bends, and the ordinary board is still four corners.
 *
 * This is what the old direction test achieved by refusing the join outright. The difference is
 * that it *only* did that: an end that genuinely bent became two boards.
 */
function collapseStraight(cell: Cell): void {
  const n = cell.edges.length;
  if (n < 3) return;
  const y0 = cell.edges[n - 3];
  const y1 = cell.edges[n - 2];
  const y2 = cell.edges[n - 1];
  const straight = (xs: number[]): boolean =>
    Math.abs(xs[n - 3] + ((xs[n - 1] - xs[n - 3]) / (y2 - y0)) * (y1 - y0) - xs[n - 2]) <= JOIN_TOL;
  if (!straight(cell.startXs) || !straight(cell.endXs)) return;
  cell.edges.splice(n - 2, 1);
  cell.startXs.splice(n - 2, 1);
  cell.endXs.splice(n - 2, 1);
}

/**
 * Continue `cell` into the sub-band above it, or start a new board.
 *
 * Two things have to hold, and each rules out a real case: the two pieces' ends must **meet**, or
 * the boundary stepped, as at the inside corner of an L, where a board reaching across the step
 * would have to be L-shaped; and their nominal intervals must **overlap**, or they are two boards
 * of one run laid end to end, which touch at a joint and share nothing else.
 *
 * What is deliberately *not* required is that the ends carry on in the same direction, nor that
 * the nominal intervals agree. A boundary that bends where it meets another — a diagonal
 * transition running into a wall — leaves the board whole and takes a corner off it. That is one
 * board, one piece of stock and two cuts on one end. Requiring the direction to continue split
 * exactly that board lengthwise into two full-length strips: a rip no installer would make, a
 * seam down the middle of a whole board, two boards bought where one was needed and two lines in
 * the cut list for one corner.
 *
 * Requiring the *intervals* to agree was the same bug wearing the other hat, and it survived the
 * first fix. The nominal interval is the long point, and a bend is precisely what moves it: the
 * half of the board whose end meets the wall square runs further along than the half the diagonal
 * cuts back, by the depth of the corner. Comparing long points therefore rejected exactly the
 * boards the direction test had just been relaxed to accept — a 7" board beside a transition came
 * out as a 2 3/4" strip and a 4 1/4" strip whose ends differed by a sixth of an inch. The ends
 * meeting is the test that separates a bend from a step; the interval carried no information the
 * ends did not already carry, beyond rejecting the case this exists to keep.
 *
 * The bend is kept as a profile point rather than smoothed into a single cut across the full
 * width, because one cut through both would either overhang the transition or leave bare floor
 * beside it, by an amount that grows without bound as the diagonal approaches parallel to the
 * run. `collapseStraight` removes the point again wherever the boundary did not really turn.
 */
function extend(open: Cell[], next: Cell): void {
  for (const cell of open) {
    const top = cell.edges.length - 1;
    if (Math.abs(cell.edges[top] - next.edges[0]) > EPS) continue;
    if (Math.abs(cell.startXs[top] - next.startXs[0]) > JOIN_TOL) continue;
    if (Math.abs(cell.endXs[top] - next.endXs[0]) > JOIN_TOL) continue;
    // Overlapping, not merely touching: two boards of one run meet end to end at a joint, and
    // their ends meet there too, so this is what tells that apart from one board that bends.
    if (Math.min(cell.end, next.end) - Math.max(cell.start, next.start) <= EPS) continue;
    cell.start = Math.min(cell.start, next.start);
    cell.end = Math.max(cell.end, next.end);
    cell.startsRun = cell.startsRun || next.startsRun;
    // Point by point, collapsing as it goes: `next` carries more than two of them wherever the
    // boundary bends *inside* its band, and a run of collinear points has to fall away one at a
    // time or the ordinary board keeps the ones in the middle.
    for (let i = 1; i < next.edges.length; i++) {
      cell.edges.push(next.edges[i]);
      cell.startXs.push(next.startXs[i]);
      cell.endXs.push(next.endXs[i]);
      collapseStraight(cell);
    }
    return;
  }
  open.push(next);
}

/**
 * Cut one interval into pieces against the joint grid `offset + k * length`.
 *
 * The grid is anchored at the layout **origin**, not at the room's bounding box, so moving the
 * origin visibly shifts every joint — which is the whole point of it being draggable. `offset`
 * carries the expansion gap with it, so "the origin" means the corner the installer measures
 * from, not the corner the first board's edge lands on; see `anchorOf` at the call site.
 */
function cutInterval(span: Interval, offset: number, length: number): Piece[] {
  const [a, b] = span;
  const pieces: Piece[] = [];
  let x = a;
  let guard = 0;
  while (b - x > EPS) {
    if (++guard > MAX_PLANKS) break;
    const k = Math.ceil((x - offset + EPS) / length);
    const joint = offset + k * length;
    const end = Math.min(joint > x + EPS ? joint : x + length, b);
    pieces.push({ start: x, end });
    x = end;
  }
  return pieces;
}

/**
 * Cut a row, honouring the minimum end cut.
 *
 * A run that ends in a 1" sliver is unusable — it snaps on install and it looks like a mistake.
 * The fix a real installer uses is to move the row's starting offset so the short piece lands
 * at the other end where it can be a whole board's worth longer; that is one retry with the
 * joint grid shifted left by the shortfall, accepted only if it does not make the *first* piece
 * too short in turn. If both ends would be short — a room narrower than the minimum — the
 * original is kept, because a slightly wrong cut list beats an infinite loop.
 */
function layRow(span: Interval, offset: number, length: number, minEndCut: number): Piece[] {
  const pieces = cutInterval(span, offset, length);
  if (pieces.length < 2 || minEndCut <= 0) return pieces;

  const sizeOf = (piece: Piece): number => piece.end - piece.start;
  const first = sizeOf(pieces[0]);
  const last = sizeOf(pieces[pieces.length - 1]);

  // Shifting the joint grid left lengthens the last piece and shortens the first; shifting it
  // right does the reverse. Only one end can be short at a time, since a shift that fixed both
  // would have to move in two directions.
  if (last < minEndCut - EPS && first - (minEndCut - last) >= minEndCut - EPS) {
    return cutInterval(span, offset - (minEndCut - last), length);
  }
  if (first < minEndCut - EPS && last - (minEndCut - first) >= minEndCut - EPS) {
    return cutInterval(span, offset + (minEndCut - first), length);
  }
  // Neither end can be fixed without breaking the other — a run barely wider than the minimum.
  // A slightly wrong cut list beats an infinite loop, so the original stands.
  return pieces;
}

// ============================================
// Waste
// ============================================

/** An off-cut shorter than this is scrap, not stock. Feet. */
const MIN_USABLE_OFFCUT_FT = 0.5;

/** One installed piece, as the purchase model sees it. */
export interface PieceDemand {
  readonly length: number;
  /** First piece of its run — the only place an off-cut can actually be used. */
  readonly startsRun: boolean;
}

/**
 * How many boards actually get bought.
 *
 * Naively every cut piece costs a whole plank, which overstates waste by nearly a factor of two:
 * the off-cut from the end of one row starts the next, and that is what installers are told to
 * do. But the reuse is not free-for-all — **only a piece that starts a run can come from an
 * off-cut**, because a mid-run board must be full length and an end piece is by definition
 * what is left over. Modelling that restriction is the difference between a plausible 5–8%
 * and an unreachable 0.2%.
 *
 * Off-cuts are matched smallest-that-fits, so long stock stays available for a long start.
 *
 * What this deliberately does **not** model: defect and damage allowance (the "add 10%" rule of
 * thumb), or the fact that an off-cut may be the wrong plank in a variegated run. Those are
 * purchasing judgement, not geometry, and inventing a number for them would make this figure
 * look more authoritative than it is.
 */
function purchaseSimulation(demand: readonly PieceDemand[], plankLength: number): number {
  const offcuts: number[] = [];
  let purchased = 0;

  for (const { length, startsRun } of demand) {
    if (length >= plankLength - EPS) {
      purchased += 1;
      continue;
    }
    let best = -1;
    if (startsRun) {
      for (let i = 0; i < offcuts.length; i++) {
        if (offcuts[i] >= length - EPS && (best < 0 || offcuts[i] < offcuts[best])) best = i;
      }
    }
    if (best >= 0) {
      const rest = offcuts[best] - length;
      offcuts.splice(best, 1);
      if (rest > MIN_USABLE_OFFCUT_FT) offcuts.push(rest);
    } else {
      purchased += 1;
      const rest = plankLength - length;
      if (rest > MIN_USABLE_OFFCUT_FT) offcuts.push(rest);
    }
  }
  return purchased;
}

/**
 * One cut piece as the cut list sees it: a long point, a short point, a mitre and a rip. Feet.
 *
 * `ripWidth` is `null` at full face width, which is the ordinary board — the same distinction the
 * entry draws, made here so that only one place decides what counts as a rip.
 */
interface CutPiece {
  readonly long: number;
  readonly short: number;
  readonly angleDeg: number;
  readonly ripWidth: number | null;
}

function buildCutList(cuts: readonly CutPiece[]): CutListEntry[] {
  const counts = new Map<string, CutListEntry & { count: number }>();
  for (const piece of cuts) {
    // The finest mark on a tape measure. Two pieces 1/64" apart are one line of the cut list.
    const eighth = (feet: number): number => Math.round(feet * INCHES_PER_FOOT * 8) / 8;
    const lengthIn = eighth(piece.long);
    const shortIn = eighth(piece.short);
    const angleDeg = Math.round(piece.angleDeg);
    const ripWidthIn = piece.ripWidth === null ? undefined : eighth(piece.ripWidth);
    // A mitre that rounds away to nothing — a wall a fraction of a degree off square — is a
    // square cut as far as a saw is concerned, and grouping it apart would split one line of
    // the list into dozens.
    const square = angleDeg === 0 || shortIn === lengthIn;
    // Every figure the line carries. Two boards are one line of the list exactly when an
    // installer would set the saw once for both; a rip is a setting, so it is in the key.
    const key = `${lengthIn}/${square ? '' : `${shortIn}/${angleDeg}`}/${ripWidthIn ?? ''}`;
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else if (square) counts.set(key, { key, lengthIn, ripWidthIn, count: 1 });
    else counts.set(key, { key, lengthIn, shortIn, angleDeg, ripWidthIn, count: 1 });
  }
  // Longest first, then the deepest mitre, then the narrowest rip — the boards an installer cuts
  // from full stock at the top, and the fiddly ones grouped together at the bottom.
  return [...counts.values()].sort(
    (a, b) =>
      b.lengthIn - a.lengthIn ||
      (b.shortIn ?? b.lengthIn) - (a.shortIn ?? a.lengthIn) ||
      (b.ripWidthIn ?? Infinity) - (a.ripWidthIn ?? Infinity)
  );
}

/**
 * The finest distinction this engine will draw between two heights, feet — 1/32".
 *
 * `EPS` is a *numerical* tolerance: it asks whether two floats are the same number. This is a
 * **physical** one, and it asks the question the band model actually needs answered — whether two
 * heights are the same place on a floor. They are not the same question, and using the first for
 * the second is what put zero-width boards on the floor.
 *
 * A band's edges come from the row grid and from every height at which an outline turns, and the
 * outlines reaching here have been through a region merge, a divider snap and a polygon inset,
 * each of which leaves vertices off true by a fraction of an inch or less. Separated at `EPS`,
 * a wall vertex a hundred-thousandth of a foot off its own wall line becomes a band 0.0001" tall
 * running the full length of that wall — and a band becomes boards, one per joint along the run.
 * A dozen of them, cut, counted, priced, and flagged as ripped below the minimum, on a floor
 * where the user can see nothing there at all.
 *
 * 1/32" because that is already finer than anything downstream can express: the cut list rounds
 * to 1/8", the panels display to 1/16", and no saw is set from either. Nothing a room can
 * legitimately contain is lost by refusing to resolve below it.
 */
const MIN_FEATURE_FT = 1 / 32 / INCHES_PER_FOOT;

/**
 * The smallest piece this engine will lay, feet — 1/4".
 *
 * `MIN_FEATURE_FT` is about *resolving* geometry; this is about **installing** it. A wall a
 * fraction of a degree out of square — which is every wall a user traces over a photo — leaves a
 * wedge between itself and the row grid, and where the run happens to be parallel to that wall
 * the wedge is a full row long. A wall 11 ft long and 0.194" out of true is a band 0.194" tall
 * spanning the room, and bands become boards: four of them, cut, counted, priced and flagged as
 * ripped below the minimum, on a floor where the user can see nothing at all. There is one board
 * there in reality and an installer scribes it to the wall; a plank's width is constant along its
 * length here, so the engine cannot describe that cut, and describing it as four sliver boards
 * instead is worse than not describing it.
 *
 * So the wedge is left bare, which is also what happens on site: a strip a quarter inch wide sits
 * under the base shoe with the expansion gap, and the gap against that wall reads as 0.25" at one
 * end and 0.44" at the other. Nothing visible, nothing purchased, nothing warned about.
 *
 * A quarter inch because that is the expansion gap's own scale — the trim covers it by definition
 * — and because no locking profile survives a rip that narrow, so a board this small is never a
 * board that gets installed. A rip the installer *would* cut, a genuine last row of half an inch
 * against a square wall, is above this and is still laid and still flagged.
 */
const MIN_BOARD_FT = 0.25 / INCHES_PER_FOOT;

/**
 * Band edges, with heights closer together than `MIN_FEATURE_FT` merged into one.
 *
 * Ascending in, ascending out. The **lower** of a merged pair survives, except at the top of the
 * room: `maxY` is the room's own extent and dropping it would end the floor short of the wall, so
 * where the last edge is absorbed it replaces the one that absorbed it rather than vanishing.
 *
 * What this costs is that a vertex within a thirty-second of an inch of a band edge is now
 * *interior* to that band, which the band model says cannot happen — so the endpoint travelling
 * through it is extrapolated along one of its two edges instead of bending at the vertex. The
 * error is bounded by the vertex's own distance from the edge, and it is spent on a feature no
 * saw could cut. A band that is genuinely there and genuinely that thin is not a board.
 */
function mergeBandEdges(sorted: readonly number[]): number[] {
  const out: number[] = [];
  for (const y of sorted) {
    if (out.length === 0 || y - out[out.length - 1] > MIN_FEATURE_FT) out.push(y);
  }
  const top = sorted[sorted.length - 1];
  if (out.length > 1 && out[out.length - 1] < top) out[out.length - 1] = top;
  return out;
}

/**
 * Every height at which an outline turns, in the run-aligned frame.
 *
 * Both properties the band model rests on come from here — no band straddles a boundary that
 * runs along the rows, and no polygon edge starts or ends inside a band — so this takes *every*
 * vertex rather than filtering for the ones that look like transitions. The room's own corners
 * are as much a boundary as a divider is: a board straddling the inside step of an L hangs half
 * of itself over the quadrant that is not there, and the corner of an obstacle is the same.
 *
 * The cost is bands. A room with 8 vertices adds at most 8 to a floor of ~30, and a band is one
 * scan whatever its height.
 */
function outlineHeights(rings: readonly (readonly Vector2[])[]): number[] {
  const out: number[] = [];
  for (const ring of rings) {
    for (const p of ring) out.push(p.y);
  }
  return out;
}

// ============================================
// The engine
// ============================================

/**
 * Derive a floor. Pure, total, and synchronous — the *caller* decides when to run it, which is
 * what `layoutProjection.ts` exists to do.
 *
 * `signal` is honoured between rows so a superseded computation stops rather than finishing and
 * being thrown away. It is optional: a test calls this directly with no signal at all, which is
 * the same reason it takes `LayoutInputs` and not a view.
 */
export function computePlankLayout(inputs: LayoutInputs, signal?: AbortSignal): PlankLayout {
  const key = layoutKey(inputs);
  const { walls, isClosed, obstacles, plank, layout, origin } = inputs;
  const regions = inputs.regions ?? null;
  // Every area assigned to carpet or tile: there is nothing of ours to lay. Distinct from the
  // unrestricted `null`, and caught before any geometry is built.
  if (regions !== null && regions.length === 0) return { ...EMPTY_LAYOUT, key };

  const plankWidth = plank.widthIn / INCHES_PER_FOOT;
  const plankLength = plank.lengthIn / INCHES_PER_FOOT;
  /**
   * Every number the frame, the grid or the gap is built from, checked for being a number.
   *
   * Both non-finite values get through an ordered comparison, and each does its own damage.
   * `NaN` passes *every* bound below — including `rowCount > MAX_PLANKS` — and comes out the far
   * end as a floor of planks whose corners are all `NaN`: drawn as nothing, hit-tested as
   * nothing, and listed in the cut list as a length no saw can be set to. `Infinity` passes the
   * `> 0` tests honestly and then lays one board per row that reaches the far wall, with a
   * purchased area of `Infinity` and a waste figure of `NaN`. An empty layout says what both of
   * them mean, and says it once.
   *
   * The codec validates each of these with `Number.isFinite` on the way in, so a stored or an
   * imported document cannot arrive here with one. A command payload is copied verbatim, so a
   * programmatic caller can, and this engine is public and pure — a test or a future caller may
   * hand it inputs no document ever held. `layout.seed` is absent deliberately: `hashFraction`
   * truncates it, so a non-finite seed is already a well-defined floor rather than a broken one.
   */
  const finite = (...values: readonly number[]): boolean => values.every(Number.isFinite);
  if (
    !isClosed ||
    walls.length < 3 ||
    !(plankWidth > 0) ||
    !(plankLength > 0) ||
    !finite(
      plankWidth,
      plankLength,
      origin.x,
      origin.y,
      layout.runAngleDeg,
      layout.expansionGapIn,
      layout.minEndCutIn,
      ...layout.rowOffsetPattern
    )
  ) {
    return { ...EMPTY_LAYOUT, key };
  }

  const theta = (layout.runAngleDeg * Math.PI) / 180;
  const { sx, sy } = cornerSigns(layout.startCorner);
  const frame: Frame = { cos: Math.cos(theta), sin: Math.sin(theta), sx, sy, origin };

  const gap = Math.max(0, layout.expansionGapIn) / INCHES_PER_FOOT;
  const minEndCut = Math.max(0, layout.minEndCutIn) / INCHES_PER_FOOT;

  /**
   * The rip minimum, in feet, clamped into `(0, plankWidth]`.
   *
   * Capped at the board's own width because a minimum above it would flag every board on the
   * floor including the un-ripped ones, which is not a warning but noise. A non-finite value
   * falls to zero — the check off — rather than poisoning the comparison into never firing,
   * which would look identical to a clean floor.
   */
  const minRip = Number.isFinite(plank.minRipWidthIn)
    ? Math.min(plankWidth, Math.max(0, plank.minRipWidthIn / INCHES_PER_FOOT))
    : 0;

  // The gap is taken out of the geometry once, here, so every wall gets it — including the ones
  // the run is parallel to, and the edges of an obstacle, which the planks stop short of too.
  const room = insetPolygon(
    walls.map((w) => toLocal(frame, w.start)),
    gap
  );
  if (room.length < 3) return { ...EMPTY_LAYOUT, key };
  const holes = obstacles.map((o) =>
    insetPolygon(
      o.walls.map((w) => toLocal(frame, w.start)),
      -gap
    )
  );

  // Each area is inset by the same gap, which is the honest reading of a floating floor: a
  // transition strip is an expansion joint, and the floor has to be able to move at one. Where
  // a region edge lies along a wall the two insets coincide, so nothing is taken twice. What is
  // *not* lost is joint alignment across a transition — the joint grid is anchored at the layout
  // origin, not at each region, so the rows either side of a T-molding still line up.
  const clips =
    regions === null
      ? null
      : regions
          .map((ring) =>
            insetPolygon(
              ring.map((p) => toLocal(frame, p)),
              gap
            )
          )
          .filter((ring) => ring.length >= 3);
  if (clips !== null && clips.length === 0) return { ...EMPTY_LAYOUT, key };

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of room) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minY) || maxY - minY <= EPS) return { ...EMPTY_LAYOUT, key };

  /**
   * Where the grid starts, measured from the layout origin along one local axis.
   *
   * The origin is the corner the installer stands in — a corner of the *room*. The floor, though,
   * starts one expansion gap inside that corner, because the gap was taken out of the geometry
   * above. Anchoring the grid at the raw origin therefore put the grid one gap *behind* the
   * floor: the row against the start wall came out `plankWidth - gap` wide and the first board
   * `plankLength - gap` long — a 7" board ripped to 4" and a 48" board cut to 45" for a 3" gap —
   * and dragging the origin swept that sliver through every width from nothing to a full board.
   *
   * One gap **into the room** instead means what the corner promises: gap, then a full board,
   * then the grid. Into the room and not simply `+gap`, because the local frame is mirrored for
   * two of the four start corners: leave the origin at the far corner and the room lies on the
   * negative side of it, where `+gap` would push the grid the wrong way and take the gap twice.
   *
   * The origin is still what every joint is measured from, so dragging it still moves every
   * joint; it now measures from the wall rather than from the edge of the first board.
   *
   * Dragged *inside* the room the origin has no wall to measure from, so the grid runs through
   * it, which is what it always did. The quarter-inch of phase that shifts as the marker crosses
   * the outline is the meaning changing, not the floor moving.
   */
  const anchorOf = (low: number, high: number): number =>
    low >= -EPS ? gap : high <= EPS ? -gap : 0;
  const ANCHOR_X = anchorOf(minX, maxX);
  const ANCHOR_Y = anchorOf(minY, maxY);

  const firstRow = Math.floor((minY - ANCHOR_Y) / plankWidth);
  const lastRow = Math.ceil((maxY - ANCHOR_Y) / plankWidth);
  const rowCount = lastRow - firstRow;
  if (rowCount <= 0 || rowCount > MAX_PLANKS)
    return { ...EMPTY_LAYOUT, key, truncated: rowCount > 0 };

  /**
   * Where one band stops and the next begins.
   *
   * The row grid `ANCHOR_Y + k * plankWidth` — anchored at the layout origin, which is what makes
   * the origin marker move the joints — plus the room's own limits, plus **every height at which
   * any outline turns**: the room's, each obstacle's, each area's. See `outlineHeights` for why
   * that set is not filtered, and the header for the two properties it buys.
   */
  const boundaries = new Set<number>([minY, maxY]);
  for (let row = firstRow; row <= lastRow; row++) {
    const y = ANCHOR_Y + row * plankWidth;
    if (y > minY + EPS && y < maxY - EPS) boundaries.add(y);
  }
  for (const y of outlineHeights([room, ...holes, ...(clips ?? [])])) {
    if (y > minY + EPS && y < maxY - EPS) boundaries.add(y);
  }
  // Merged at a physical tolerance, not at `EPS`: see `mergeBandEdges`. Sub-tolerance wobble in
  // an outline is not a row of boards.
  const bandEdges = mergeBandEdges([...boundaries].sort((a, b) => a - b));

  const planks: Plank[] = [];
  const demand: PieceDemand[] = [];
  const cuts: CutPiece[] = [];
  let covered = 0;
  let fullPieces = 0;
  let narrowPieces = 0;
  let narrowestRip = Infinity;
  let truncated = false;

  /** The row a band belongs to — sub-bands of one row share its offset and so its joints. */
  const rowOfBand = (low: number, high: number): number =>
    Math.floor(((low + high) / 2 - ANCHOR_Y) / plankWidth);

  let band = 0;
  while (band + 1 < bandEdges.length && !truncated) {
    if (signal?.aborted) {
      truncated = true;
      break;
    }
    const row = rowOfBand(bandEdges[band], bandEdges[band + 1]);
    const offset = ANCHOR_X + rowOffset(row, layout, plankLength);
    const open: Cell[] = [];
    const bands: { low: number; high: number; spans: BandSpan[] }[] = [];

    // Every sub-band this row was split into, scanned but not yet cut.
    while (band + 1 < bandEdges.length) {
      // The band, already clipped to the room and to every area edge by construction. A band
      // against a wall or a transition is **ripped** narrower rather than dropped — dropping it
      // would silently leave a strip of bare subfloor and under-report the area. Its own width is
      // what makes the rip show up as waste: a ripped board still costs a full-width one.
      const bandLow = bandEdges[band];
      const bandHigh = bandEdges[band + 1];
      if (bandHigh - bandLow > EPS && rowOfBand(bandLow, bandHigh) !== row) break;
      band += 1;
      if (bandHigh - bandLow <= EPS) continue;

      // Room, then areas, then obstacles. The areas are unioned before they intersect, so two
      // adjacent plank areas read as one span rather than as a seam the row is cut at twice.
      let spans = bandIntervalsAt(room, bandLow, bandHigh);
      if (clips !== null) {
        spans = intersectBandSpans(
          spans,
          unionBandSpans(clips.flatMap((clip) => bandIntervalsAt(clip, bandLow, bandHigh)))
        );
      }
      bands.push({
        low: bandLow,
        high: bandHigh,
        spans: subtractBandSpans(
          spans,
          holes.flatMap((hole) => bandIntervalsAt(hole, bandLow, bandHigh))
        ).sort((a, b) => bandMid(a[0]) - bandMid(b[0])),
      });
    }

    /**
     * The row's joints, decided once for the whole row rather than per sub-band.
     *
     * `layRow`'s minimum-end-cut retry shifts the *entire* joint grid of a run to move a sliver
     * from one end to the other, so running it per sub-band gives two sub-bands of one row two
     * different sets of joints — which jogs the joints at the split and, worse, means no piece
     * can ever be knitted back to the one above it. A row's joints are a property of the row.
     *
     * The **long point** extent, because a board cut to a diagonal wall reaches it at one corner
     * and that corner is what the grid and the cut list are measured against.
     */
    const extentOf = ([s, e]: BandSpan): Interval => [Math.min(s.lo, s.hi), Math.max(e.lo, e.hi)];
    const extents = bands.flatMap((b) => b.spans.map(extentOf));

    /**
     * …and broken wherever one sub-band's coverage begins or ends.
     *
     * Where the boundary steps in the middle of a row — the inside corner of an L, the edge of an
     * island — a board reaching past the step would have to be L-shaped. It cannot be, so it is
     * cut *at* the step rather than ripped along it: one whole board up to the corner, and a
     * short piece beyond it in whichever sub-band still has floor. That is the cut an installer
     * makes, and it leaves the boards short of the step whole.
     */
    const breaks = new Set<number>();
    for (const [a, b] of extents) {
      breaks.add(a);
      breaks.add(b);
    }
    const runs = unionIntervals(extents).flatMap(([a, b]): Interval[] => {
      const out: Interval[] = [];
      let prev = a;
      for (const x of [...breaks].sort((p, q) => p - q)) {
        // At `MIN_BOARD_FT` rather than at `EPS`: a break this close to where the run already
        // starts or ends cuts a piece off it too small to lay, and the emit then drops that piece
        // and leaves the floor short by its length. That is how a quarter inch of bare subfloor
        // appeared beside a transition where two boundaries meet at a shallow angle — the wall's
        // end of the row and the diagonal's long point are a hair apart there, and the hair
        // became a break, then a sliver, then a hole. Not breaking is the same board reaching the
        // wall, which is what an installer would cut.
        if (x <= prev + MIN_BOARD_FT || x >= b - MIN_BOARD_FT) continue;
        out.push([prev, x]);
        prev = x;
      }
      if (b - prev > EPS) out.push([prev, b]);
      return out;
    });
    // Disjoint and ascending, so clipping them to a span decomposes it exactly.
    const jointed = runs.flatMap((run) => layRow(run, offset, plankLength, minEndCut));

    for (const { low: bandLow, high: bandHigh, spans } of bands) {
      const height = bandHigh - bandLow;
      for (const span of spans) {
        const [start, end] = extentOf(span);
        if (end - start <= EPS) continue;

        /**
         * Either end of the span, anywhere across the band — linear in `t`, which is the property
         * the whole band model is built to guarantee (see the header).
         */
        const spanEdgeAt = (p: BandPoint, t: number): number => p.lo + (p.hi - p.lo) * t;

        let first = true;
        for (const piece of jointed) {
          // The row's joints, clipped to what this sub-band covers *somewhere* in its height.
          const from = Math.max(piece.start, start);
          const to = Math.min(piece.end, end);
          if (to - from <= EPS) continue;

          /**
           * How much floor sits under this piece at height `t` across the band.
           *
           * A minimum of two linear functions less a maximum of two, so it is **concave** in `t`
           * and positive on a single interval — and that interval, not the band, is the part of
           * the band this board exists in.
           *
           * Reading it as the whole band is the bug this replaces. Every piece of the span was
           * laid from `bandLow` to `bandHigh` and its ends clamped into the span at each; where
           * the span closed to a point at one edge, every piece clamped onto that same point,
           * wherever it was. Against a wall a fraction of a degree out of square — which is any
           * room traced by hand, with the run across it — the span closes over a band a fifth of
           * an inch tall and the point is the far corner of the room. Every board in that row
           * took that corner as a corner of its own: an outline doubling back through itself,
           * boards overlapping the width of the room, `coveredSqft` counted off triangles that
           * are not there, and `PlankIndex` answering with a board nowhere near the cursor. On
           * the fixture in `a transition landing on a room corner` that was 20 corners landing
           * outside the board they belong to, the worst of them by 223 inches.
           */
          const widthAt = (t: number): number =>
            Math.min(to, spanEdgeAt(span[1], t)) - Math.max(from, spanEdgeAt(span[0], t));

          /**
           * The heights the width bends at: where the boundary crosses one of the piece's own
           * ends, so that the piece stops being bounded by its joint and starts being bounded by
           * the room. Kept as profile points, because that bend is a real corner of the board.
           */
          const knots = [0, 1];
          for (const [point, x] of [
            [span[0], from],
            [span[1], to],
          ] as const) {
            const travel = point.hi - point.lo;
            if (Math.abs(travel) <= EPS) continue;
            const t = (x - point.lo) / travel;
            if (t > EPS && t < 1 - EPS) knots.push(t);
          }
          knots.sort((a, b) => a - b);

          // The interval where there is floor. Concavity is what lets this be one interval, and
          // what lets it be found by walking the knots once.
          let tLow = Infinity;
          let tHigh = -Infinity;
          for (let i = 0; i + 1 < knots.length; i++) {
            const t0 = knots[i];
            const t1 = knots[i + 1];
            const w0 = widthAt(t0);
            const w1 = widthAt(t1);
            if (w0 <= 0 && w1 <= 0) continue;
            const root = t0 + ((t1 - t0) * w0) / (w0 - w1);
            tLow = Math.min(tLow, w0 > 0 ? t0 : root);
            tHigh = Math.max(tHigh, w1 > 0 ? t1 : root);
          }
          // No floor under this piece anywhere in this band. It is not a board here, and the
          // sliver it would have been is left to the board that does reach it.
          if (!(tHigh > tLow)) continue;

          const profile = [tLow, ...knots.filter((t) => t > tLow + EPS && t < tHigh - EPS), tHigh];
          extend(open, {
            start: from,
            end: to,
            startsRun: first,
            edges: profile.map((t) => bandLow + height * t),
            startXs: profile.map((t) => Math.max(from, spanEdgeAt(span[0], t))),
            endXs: profile.map((t) => Math.min(to, spanEdgeAt(span[1], t))),
          });
          first = false;
        }
      }
    }

    // What is actually installable, on both axes: the wedge against an out-of-square wall and
    // the crumb in the corner where two boundaries converge are floor, but they are not boards.
    // See `MIN_BOARD_FT`. What is dropped here is dropped from everything — not laid, not
    // counted toward `coveredSqft`, not purchased, not in the cut list, not flagged as narrow.
    const laid = open.filter(
      (cell) =>
        cell.end - cell.start >= MIN_BOARD_FT &&
        cell.edges[cell.edges.length - 1] - cell.edges[0] >= MIN_BOARD_FT
    );
    // Bottom-to-top, then along the run: the order an installer would lay them, and the order
    // `column` and `startsRun` are only meaningful in.
    laid.sort((a, b) => a.edges[0] - b.edges[0] || a.start - b.start);
    for (let column = 0; column < laid.length; column++) {
      if (planks.length >= MAX_PLANKS) {
        truncated = true;
        break;
      }
      const cell = laid[column];
      const points = cell.edges.length;
      const bandLow = cell.edges[0];
      const bandHigh = cell.edges[points - 1];
      const width = bandHigh - bandLow;
      const length = cell.end - cell.start;
      /** The board's length at each profile point — its long point is the longest of them. */
      const spans = cell.edges.map((_, i) => cell.endXs[i] - cell.startXs[i]);
      /**
       * The steepest cut on the board, how far off square it is, and the short point it leaves.
       *
       * Per **segment** rather than end to end: a board whose end bends is cut twice, and an
       * installer sets the saw from the steeper of the two. Measured across that segment's own
       * height, since an angle is a ratio and the segment is what the cut runs across.
       *
       * A segment shorter than `MIN_BOARD_FT` across the board's width is skipped, and that is
       * the difference between a cut and a **scribe**. The boundary a board meets is only as
       * straight as the wall it was traced from, so the last row against a wall a fraction of a
       * degree out of square carries a taper a fifth of an inch tall at one corner. Read as a
       * cut it is a mitre of nearly 90° down to a short point of zero — a saw setting that does
       * not exist, on a line of the cut list for a board that was cut square and scribed to the
       * wall. Read as what it is, the board is what the rest of its width says it is.
       */
      let slant = 0;
      let steepest = 0;
      let shortest = Infinity;
      for (let i = 0; i + 1 < points; i++) {
        const rise = cell.edges[i + 1] - cell.edges[i];
        if (rise < MIN_BOARD_FT) continue;
        const run = Math.max(
          Math.abs(cell.startXs[i + 1] - cell.startXs[i]),
          Math.abs(cell.endXs[i + 1] - cell.endXs[i])
        );
        slant = Math.max(slant, run);
        steepest = Math.max(steepest, Math.atan2(run, rise));
        shortest = Math.min(shortest, spans[i], spans[i + 1]);
      }
      const mitred = slant > EPS;
      /**
       * A rip, and how bad. Measured against the nominal width rather than against the band grid,
       * so a board narrowed by an obstacle's corner counts the same as one narrowed by a wall —
       * both are a strip the installer has to cut down the length of, and both fail the same way.
       *
       * At `MIN_FEATURE_FT` rather than at `EPS`, for the reason written up there: this asks
       * whether the board is narrower than its stock, which is a question about a floor and not
       * about two floats. A wobble in the outline left boards a hundred-thousandth of a foot
       * under the face width, and at `EPS` each was a rip — a line of the cut list of its own,
       * reading `rip 7"` on a 7" plank.
       */
      const ripped = width < plankWidth - MIN_FEATURE_FT;
      const narrow = ripped && width < minRip - EPS;
      if (narrow) narrowPieces += 1;
      if (ripped && width < narrowestRip) narrowestRip = width;
      /**
       * Whether this board goes on a saw at all — **one** definition, read three times.
       *
       * It decides `Plank.cut`, which of `cutPieces` and `fullPieces` this board lands in, and
       * whether it gets a line of the cut list. Those used to disagree: the rip was in the first
       * and out of the other two, so a floor of 66 boards reported 36 "full" while 32 of them
       * answered `cut`, and the two boards that were ripped at stock length were counted as
       * whole boards and listed nowhere at all. Clicking one said "cut" and the panel said the
       * opposite about the same board.
       */
      const cut = length < plankLength - EPS || ripped || mitred;

      planks.push({
        id: `p${row}:${column}`,
        row,
        column,
        center: toWorld(frame, {
          x: (cell.start + cell.end) / 2,
          y: (bandLow + bandHigh) / 2,
        }),
        length,
        width,
        // Up the end side, then back down the start side. See `Plank.corners` for the order and
        // why it is a polygon rather than four points.
        corners: [
          toWorld(frame, { x: cell.startXs[0], y: cell.edges[0] }),
          ...cell.edges.map((y, i) => toWorld(frame, { x: cell.endXs[i], y })),
          ...cell.edges
            .map((y, i) => toWorld(frame, { x: cell.startXs[i], y }))
            .slice(1)
            .reverse(),
        ],
        cut,
        narrow,
      });
      // A ripped board consumes a full-width one, so demand is length-only; the rip shows up
      // as waste because `coveredSqft` counts the narrower installed strip. The extent rather
      // than the long point, because that is how much of the stock the cut consumes.
      demand.push({ length, startsRun: cell.startsRun });
      // The board's own outline, not the nominal rectangle: this is the area actually laid. One
      // trapezoid per segment, which is the same figure as before for a board that does not bend.
      for (let i = 0; i + 1 < points; i++) {
        covered += ((spans[i] + spans[i + 1]) / 2) * (cell.edges[i + 1] - cell.edges[i]);
      }
      // A mitred or ripped board is a cut board even at stock length — it still has to go on a
      // saw, and an installer who cannot find it in the cut list will lay it whole.
      if (cut) {
        cuts.push({
          // The long point over the *whole* profile, because that is the stock the cut consumes;
          // the short point only over the segments that are cuts, so a scribe does not report a
          // board as tapering to nothing. With no cut to measure the two coincide, and
          // `buildCutList` lists it as the square cut it is.
          long: Math.max(...spans),
          short: shortest === Infinity ? Math.max(...spans) : shortest,
          // Off square, from the steepest of the board's cuts. A board with a corner clipped off
          // is one piece of stock with two cuts on one end; the list carries the one an installer
          // has to set the saw for, and the long and short points bracket what it takes off.
          angleDeg: (steepest * 180) / Math.PI,
          // The finished width, which is the second setting the saw needs. Null at full face
          // width, so the ordinary board's line stays a length and nothing else.
          ripWidth: ripped ? width : null,
        });
      } else fullPieces += 1;
    }
  }

  const purchasedPlanks = purchaseSimulation(demand, plankLength);
  const coveredSqft = covered;
  const purchasedSqft = purchasedPlanks * plankLength * plankWidth;
  const wastePercent =
    purchasedSqft > 0 ? ((purchasedSqft - coveredSqft) / purchasedSqft) * 100 : 0;

  return {
    key,
    planks,
    cutList: buildCutList(cuts),
    // The mirror is a frame detail; a renderer only needs the world-space run direction, and
    // a plank rotated by 180° looks identical, so the un-mirrored angle is the right one.
    angle: theta,
    fullPieces,
    cutPieces: cuts.length,
    purchasedPlanks,
    coveredSqft,
    purchasedSqft,
    wastePercent,
    narrowPieces,
    narrowestRipIn: narrowestRip === Infinity ? null : narrowestRip * INCHES_PER_FOOT,
    truncated,
  };
}
