import type { Obstacle, Vector2, WallSegment } from '../../floorplan/types/geometry';
import type { LayoutConfig, PlankSpec, StartCorner } from './types';
import { INCHES_PER_FOOT, MAX_PLANKS } from './types';
import type { Interval } from './geometry2d';
import {
  EPS,
  intersectIntervals,
  intervalsAt,
  signedArea,
  subtractIntervals,
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
 * Within that frame each row is a horizontal band. The engine scan-lines the band's centreline
 * against the room polygon to get the intervals that are inside the room, subtracts the same
 * scan against every obstacle polygon, and lays planks along what is left. A scan line rather
 * than a polygon boolean because the room is frequently concave (an L-shaped kitchen) and
 * Sutherland–Hodgman clipping is only correct against a convex clip region — and because a cut
 * list wants piece *lengths* along the run, which is exactly what an interval gives.
 *
 * When `regions` is given the same scan is also intersected with the areas assigned to this
 * floor, so the run stops where the LVP stops and the carpet begins. Rows are still indexed
 * against the **room**, not the region, which is what keeps the stagger pattern and the joint
 * grid continuous across a transition instead of restarting on the far side of it.
 *
 * The approximation this buys is named, not hidden. A row is sampled on **one** line, so where
 * the outline changes within a row's band — a diagonal wall, the inside step of an L, or a
 * region edge running parallel to the run — that row is laid as if the whole band looked like
 * its centreline. At a *wall* this under-reports, because the band is clamped to the room and
 * the last row is ripped; at a *region* edge it over-reports by up to one plank width along the
 * edge, because a row straddling a transition is laid whole rather than ripped at it. The error is bounded by
 * one plank width along the step and it under-reports rather than over-reports (an L-shaped
 * 300 sqft room comes out at 299.2). For a rectilinear room whose walls fall on row boundaries
 * — and for every obstacle this editor draws — the result is exact. Mitring against a diagonal
 * wall is the same story: the piece is cut square at the interval end.
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
  /** World-space centre of the piece. */
  readonly center: Vector2;
  /** Along-run length, feet. */
  readonly length: number;
  /** Across-run width, feet. Less than the plank width when the row is ripped at a wall. */
  readonly width: number;
  /** True when the piece was cut — shorter than a full plank, or ripped narrower. */
  readonly cut: boolean;
}

/** One line of the cut list: "14 pieces at 23 1/2 in". */
export interface CutListEntry {
  /** Rounded to the nearest 1/8 in — the finest mark on a tape measure. */
  readonly lengthIn: number;
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
    `${n(plank.widthIn)}x${n(plank.lengthIn)}`,
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
 * Cut one interval into pieces against the joint grid `offset + k * length`.
 *
 * The grid is anchored at the layout **origin**, not at the room's bounding box, so moving the
 * origin visibly shifts every joint — which is the whole point of it being draggable.
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

function buildCutList(cutLengthsFt: readonly number[]): CutListEntry[] {
  const counts = new Map<number, number>();
  for (const feet of cutLengthsFt) {
    // The finest mark on a tape measure. Two pieces 1/64" apart are one line of the cut list.
    const eighths = Math.round(feet * INCHES_PER_FOOT * 8);
    const lengthIn = eighths / 8;
    counts.set(lengthIn, (counts.get(lengthIn) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([lengthIn, count]) => ({ lengthIn, count }))
    .sort((a, b) => b.lengthIn - a.lengthIn);
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
  if (!isClosed || walls.length < 3 || plankWidth <= 0 || plankLength <= 0) {
    return { ...EMPTY_LAYOUT, key };
  }

  const theta = (layout.runAngleDeg * Math.PI) / 180;
  const { sx, sy } = cornerSigns(layout.startCorner);
  const frame: Frame = { cos: Math.cos(theta), sin: Math.sin(theta), sx, sy, origin };

  const gap = Math.max(0, layout.expansionGapIn) / INCHES_PER_FOOT;
  const minEndCut = Math.max(0, layout.minEndCutIn) / INCHES_PER_FOOT;

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

  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of room) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minY) || maxY - minY <= EPS) return { ...EMPTY_LAYOUT, key };

  const firstRow = Math.floor(minY / plankWidth);
  const lastRow = Math.ceil(maxY / plankWidth);
  const rowCount = lastRow - firstRow;
  if (rowCount <= 0 || rowCount > MAX_PLANKS)
    return { ...EMPTY_LAYOUT, key, truncated: rowCount > 0 };

  const planks: Plank[] = [];
  const demand: PieceDemand[] = [];
  const cutLengths: number[] = [];
  let covered = 0;
  let fullPieces = 0;
  let truncated = false;

  for (let row = firstRow; row < lastRow; row++) {
    if (signal?.aborted) {
      truncated = true;
      break;
    }
    // The band this row occupies, clipped to the room. The last row against a wall is
    // **ripped** narrower rather than dropped — dropping it would silently leave a strip of
    // bare subfloor and under-report the area by up to one plank width across the room.
    // Its own width is what makes the rip show up as waste: a ripped board still costs a
    // full-width one.
    const bandLow = Math.max(row * plankWidth, minY);
    const bandHigh = Math.min((row + 1) * plankWidth, maxY);
    const rowWidth = bandHigh - bandLow;
    if (rowWidth <= EPS) continue;
    const centreY = (bandLow + bandHigh) / 2;

    // Room, then areas, then obstacles. The areas are unioned before they intersect, so two
    // adjacent plank areas read as one span rather than as a seam the row is cut at twice.
    let spans = intervalsAt(room, centreY);
    if (clips !== null) {
      spans = intersectIntervals(
        spans,
        unionIntervals(clips.flatMap((clip) => intervalsAt(clip, centreY)))
      );
    }
    spans = subtractIntervals(
      spans,
      holes.flatMap((hole) => intervalsAt(hole, centreY))
    ).sort((a, b) => a[0] - b[0]);

    const offset = rowOffset(row, layout, plankLength);
    let column = 0;

    for (const [start, end] of spans) {
      if (end - start <= EPS) continue;

      const pieces = layRow([start, end], offset, plankLength, minEndCut);
      for (let index = 0; index < pieces.length; index++) {
        const piece = pieces[index];
        if (planks.length >= MAX_PLANKS) {
          truncated = true;
          break;
        }
        const length = piece.end - piece.start;
        if (length <= EPS) continue;
        const cut = length < plankLength - EPS || rowWidth < plankWidth - EPS;
        planks.push({
          id: `p${row}:${column}`,
          row,
          column,
          center: toWorld(frame, { x: (piece.start + piece.end) / 2, y: centreY }),
          length,
          width: rowWidth,
          cut,
        });
        // A ripped board consumes a full-width one, so demand is length-only; the rip shows up
        // as waste because `coveredSqft` counts the narrower installed strip.
        demand.push({ length, startsRun: index === 0 });
        covered += length * rowWidth;
        if (length < plankLength - EPS) cutLengths.push(length);
        else fullPieces += 1;
        column += 1;
      }
      if (truncated) break;
    }
    if (truncated) break;
  }

  const purchasedPlanks = purchaseSimulation(demand, plankLength);
  const coveredSqft = covered;
  const purchasedSqft = purchasedPlanks * plankLength * plankWidth;
  const wastePercent =
    purchasedSqft > 0 ? ((purchasedSqft - coveredSqft) / purchasedSqft) * 100 : 0;

  return {
    key,
    planks,
    cutList: buildCutList(cutLengths),
    // The mirror is a frame detail; a renderer only needs the world-space run direction, and
    // a plank rotated by 180° looks identical, so the un-mirrored angle is the right one.
    angle: theta,
    fullPieces,
    cutPieces: cutLengths.length,
    purchasedPlanks,
    coveredSqft,
    purchasedSqft,
    wastePercent,
    truncated,
  };
}
