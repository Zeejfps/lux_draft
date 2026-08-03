import type { Obstacle, Vector2, WallSegment } from '../../floorplan/types/geometry';
import type { LayoutConfig, PlankSpec, StartCorner } from './types';
import { INCHES_PER_FOOT, MAX_PLANKS } from './types';
import type { BandSpan, Interval } from './geometry2d';
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
   * World-space corners, run-frame order: `(start, low)`, `(end, low)`, `(end, high)`,
   * `(start, high)`. A rectangle of `length` x `width` about `center` unless an end was cut to a
   * boundary that is not square to the run, in which case that end is slanted and the piece is a
   * trapezoid. Where two such boundaries meet it can collapse to a triangle — two of the four
   * corners coincide, which is the piece that actually gets installed there.
   */
  readonly corners: readonly [Vector2, Vector2, Vector2, Vector2];
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

/** One line of the cut list: "14 pieces at 23 1/2 in", or "3 at 48 → 41 1/2 in @ 22°". */
export interface CutListEntry {
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

/** How far a mitred vertex may travel, in gaps, before it is clamped. */
const MAX_MITER = 4;

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
 * Joins are mitred — exact for the rectilinear corner that every room here is made of — and
 * clamped, since an uncapped miter shoots off toward infinity as a vertex approaches a spike. A
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
    let ox = (before.x + after.x) * scale;
    let oy = (before.y + after.y) * scale;
    const reach = Math.hypot(ox, oy);
    const limit = Math.abs(distance) * MAX_MITER;
    if (reach > limit) {
      ox *= limit / reach;
      oy *= limit / reach;
    }
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
  /** Fixed: the nominal x interval, which is what decides whether two pieces are the same board. */
  readonly start: number;
  readonly end: number;
  readonly startsRun: boolean;
  bandLow: number;
  bandHigh: number;
  startLo: number;
  endLo: number;
  startHi: number;
  endHi: number;
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
 * Continue `cell` into the sub-band above it, or start a new board.
 *
 * Three things have to hold, and each rules out a real case: the pieces must occupy the same
 * interval along the run (or they are different boards), their ends must meet (or the boundary
 * stepped, as at the inside corner of an L), and the ends must carry on in the same direction
 * (or the boundary turned, as where two diagonal walls meet).
 */
function extend(open: Cell[], next: Cell): void {
  const project = (lo: number, hi: number, y0: number, y1: number, y: number): number =>
    lo + ((hi - lo) / (y1 - y0)) * (y - y0);
  for (const cell of open) {
    if (Math.abs(cell.bandHigh - next.bandLow) > EPS) continue;
    if (Math.abs(cell.start - next.start) > JOIN_TOL) continue;
    if (Math.abs(cell.end - next.end) > JOIN_TOL) continue;
    if (Math.abs(cell.startHi - next.startLo) > JOIN_TOL) continue;
    if (Math.abs(cell.endHi - next.endLo) > JOIN_TOL) continue;
    const startOn = project(cell.startLo, cell.startHi, cell.bandLow, cell.bandHigh, next.bandHigh);
    const endOn = project(cell.endLo, cell.endHi, cell.bandLow, cell.bandHigh, next.bandHigh);
    if (Math.abs(startOn - next.startHi) > JOIN_TOL) continue;
    if (Math.abs(endOn - next.endHi) > JOIN_TOL) continue;
    cell.bandHigh = next.bandHigh;
    cell.startHi = next.startHi;
    cell.endHi = next.endHi;
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

/** One cut piece as the cut list sees it: a long point, a short point and a mitre. Feet. */
interface CutPiece {
  readonly long: number;
  readonly short: number;
  readonly angleDeg: number;
}

function buildCutList(cuts: readonly CutPiece[]): CutListEntry[] {
  const counts = new Map<string, CutListEntry & { count: number }>();
  for (const piece of cuts) {
    // The finest mark on a tape measure. Two pieces 1/64" apart are one line of the cut list.
    const eighth = (feet: number): number => Math.round(feet * INCHES_PER_FOOT * 8) / 8;
    const lengthIn = eighth(piece.long);
    const shortIn = eighth(piece.short);
    const angleDeg = Math.round(piece.angleDeg);
    // A mitre that rounds away to nothing — a wall a fraction of a degree off square — is a
    // square cut as far as a saw is concerned, and grouping it apart would split one line of
    // the list into dozens.
    const square = angleDeg === 0 || shortIn === lengthIn;
    const key = square ? `${lengthIn}` : `${lengthIn}/${shortIn}/${angleDeg}`;
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else
      counts.set(key, square ? { lengthIn, count: 1 } : { lengthIn, shortIn, angleDeg, count: 1 });
  }
  return [...counts.values()].sort(
    (a, b) => b.lengthIn - a.lengthIn || (b.shortIn ?? b.lengthIn) - (a.shortIn ?? a.lengthIn)
  );
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
  const bandEdges = [...boundaries].sort((a, b) => a - b);

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
        if (x <= prev + EPS || x >= b - EPS) continue;
        out.push([prev, x]);
        prev = x;
      }
      if (b - prev > EPS) out.push([prev, b]);
      return out;
    });
    // Disjoint and ascending, so clipping them to a span decomposes it exactly.
    const jointed = runs.flatMap((run) => layRow(run, offset, plankLength, minEndCut));

    for (const { low: bandLow, high: bandHigh, spans } of bands) {
      for (const span of spans) {
        const [start, end] = extentOf(span);
        if (end - start <= EPS) continue;

        // Where a piece's ends actually land, on each edge of the band. Clamping into the span
        // rather than only slanting the first and last piece is what keeps this right when the
        // boundary is shallow enough that its slant across one band exceeds a plank length: the
        // pieces beyond the span's end at that edge collapse onto it instead of hanging past it.
        const clampAt = (x: number, edge: 'lo' | 'hi'): number => {
          const a = span[0][edge];
          const b = span[1][edge];
          // The span has no width on this edge — the piece is a triangle with its apex here.
          if (b - a <= 0) return (a + b) / 2;
          return Math.min(Math.max(x, a), b);
        };

        let first = true;
        for (const piece of jointed) {
          // The row's joints, clipped to what this sub-band actually covers.
          const from = Math.max(piece.start, start);
          const to = Math.min(piece.end, end);
          if (to - from <= EPS) continue;
          extend(open, {
            start: from,
            end: to,
            startsRun: first,
            bandLow,
            bandHigh,
            startLo: clampAt(from, 'lo'),
            endLo: clampAt(to, 'lo'),
            startHi: clampAt(from, 'hi'),
            endHi: clampAt(to, 'hi'),
          });
          first = false;
        }
      }
    }

    // Bottom-to-top, then along the run: the order an installer would lay them, and the order
    // `column` and `startsRun` are only meaningful in.
    open.sort((a, b) => a.bandLow - b.bandLow || a.start - b.start);
    for (let column = 0; column < open.length; column++) {
      if (planks.length >= MAX_PLANKS) {
        truncated = true;
        break;
      }
      const cell = open[column];
      const width = cell.bandHigh - cell.bandLow;
      const length = cell.end - cell.start;
      const lowLength = cell.endLo - cell.startLo;
      const highLength = cell.endHi - cell.startHi;
      const slant = Math.max(
        Math.abs(cell.startHi - cell.startLo),
        Math.abs(cell.endHi - cell.endLo)
      );
      const mitred = slant > EPS;
      // A rip, and how bad. Measured against the nominal width rather than against the band grid,
      // so a board narrowed by an obstacle's corner counts the same as one narrowed by a wall —
      // both are a strip the installer has to cut down the length of, and both fail the same way.
      const ripped = width < plankWidth - EPS;
      const narrow = ripped && width < minRip - EPS;
      if (narrow) narrowPieces += 1;
      if (ripped && width < narrowestRip) narrowestRip = width;

      planks.push({
        id: `p${row}:${column}`,
        row,
        column,
        center: toWorld(frame, {
          x: (cell.start + cell.end) / 2,
          y: (cell.bandLow + cell.bandHigh) / 2,
        }),
        length,
        width,
        corners: [
          toWorld(frame, { x: cell.startLo, y: cell.bandLow }),
          toWorld(frame, { x: cell.endLo, y: cell.bandLow }),
          toWorld(frame, { x: cell.endHi, y: cell.bandHigh }),
          toWorld(frame, { x: cell.startHi, y: cell.bandHigh }),
        ],
        cut: length < plankLength - EPS || ripped || mitred,
        narrow,
      });
      // A ripped board consumes a full-width one, so demand is length-only; the rip shows up
      // as waste because `coveredSqft` counts the narrower installed strip. The extent rather
      // than the long point, because that is how much of the stock the cut consumes.
      demand.push({ length, startsRun: cell.startsRun });
      // The trapezoid, not the nominal rectangle: this is the area actually laid.
      covered += ((lowLength + highLength) / 2) * width;
      // A mitred board is a cut board even at stock length — it still has to go on a saw, and an
      // installer who cannot find it in the cut list will cut it square.
      if (mitred || length < plankLength - EPS) {
        cuts.push({
          long: Math.max(lowLength, highLength),
          short: Math.min(lowLength, highLength),
          // Off square, measured across the board — which is the board's own width, not the
          // nominal plank width, since a ripped board is cut at the width it ends up.
          angleDeg: (Math.atan2(slant, width) * 180) / Math.PI,
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
