import type { Vector2 } from '../../floorplan/types/geometry';

/**
 * Plane geometry shared by the layout engine and the region solver. **Eager-safe** and pure:
 * plain numbers in, plain numbers out, no `three`, no store, no allocation the caller cannot see.
 *
 * These primitives lived inside `PlankLayoutEngine` until the region solver needed the same
 * scan-line and the same interval algebra. Nothing here knows about planks, dividers or feet —
 * it is the one place the even-odd rule and the `EPS` tolerance are written down, so the engine
 * and the solver cannot disagree about whether a point is inside a room.
 */

export const EPS = 1e-9;

/** A closed span on a scan line, `[start, end]`, ascending. */
export type Interval = readonly [number, number];

// ============================================
// Polygons
// ============================================

/** Positive for a counter-clockwise ring. Winding is detected, never assumed. */
export function signedArea(polygon: readonly Vector2[]): number {
  let sum = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    sum += polygon[j].x * polygon[i].y - polygon[i].x * polygon[j].y;
  }
  return sum / 2;
}

export function polygonArea(polygon: readonly Vector2[]): number {
  return Math.abs(signedArea(polygon));
}

/** Even-odd containment. A point exactly on an edge may answer either way; callers probe off it. */
export function pointInPolygon(polygon: readonly Vector2[], p: Vector2): boolean {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = polygon[j];
    const b = polygon[i];
    if (a.y > p.y !== b.y > p.y) {
      const x = a.x + ((p.y - a.y) / (b.y - a.y)) * (b.x - a.x);
      if (p.x < x) inside = !inside;
    }
  }
  return inside;
}

/** Ascending x values where the polygon's edges cross the horizontal line `y`. */
export function crossings(polygon: readonly Vector2[], y: number): number[] {
  const xs: number[] = [];
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = polygon[j];
    const b = polygon[i];
    if (a.y > y !== b.y > y) {
      xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
  }
  return xs.sort((p, q) => p - q);
}

export function intervalsAt(polygon: readonly Vector2[], y: number): Interval[] {
  const xs = crossings(polygon, y);
  const out: Interval[] = [];
  for (let i = 0; i + 1 < xs.length; i += 2) {
    if (xs[i + 1] - xs[i] > EPS) out.push([xs[i], xs[i + 1]]);
  }
  return out;
}

/**
 * The same scan turned on its side: spans of the polygon along the **vertical** line `x`.
 *
 * The horizontal scan gives a row its length; this gives a row its width. A row is laid across
 * a band, and a clip edge running along the band — a divider parallel to the run — cuts the
 * band without touching the row's ends, so the horizontal scan cannot see it at all.
 */
export function verticalIntervalsAt(polygon: readonly Vector2[], x: number): Interval[] {
  const ys: number[] = [];
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = polygon[j];
    const b = polygon[i];
    if (a.x > x !== b.x > x) {
      ys.push(a.y + ((x - a.x) / (b.x - a.x)) * (b.y - a.y));
    }
  }
  ys.sort((p, q) => p - q);
  const out: Interval[] = [];
  for (let i = 0; i + 1 < ys.length; i += 2) {
    if (ys[i + 1] - ys[i] > EPS) out.push([ys[i], ys[i + 1]]);
  }
  return out;
}

// ============================================
// Interval algebra
// ============================================

/** `spans` minus `holes`. Both ascending and non-overlapping; the result is too. */
export function subtractIntervals(spans: Interval[], holes: Interval[]): Interval[] {
  if (holes.length === 0) return spans;
  let current = spans;
  for (const [hs, he] of holes) {
    const next: Interval[] = [];
    for (const [s, e] of current) {
      if (he <= s + EPS || hs >= e - EPS) {
        next.push([s, e]);
        continue;
      }
      if (hs - s > EPS) next.push([s, hs]);
      if (e - he > EPS) next.push([he, e]);
    }
    current = next;
  }
  return current;
}

/** Merge overlapping or touching spans. Input need not be sorted; output is ascending. */
export function unionIntervals(spans: readonly Interval[]): Interval[] {
  const sorted = spans.filter(([s, e]) => e - s > EPS).sort((p, q) => p[0] - q[0]);
  const out: [number, number][] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1] + EPS) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** Both ascending and non-overlapping; the result is too. */
export function intersectIntervals(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i][0], b[j][0]);
    const end = Math.min(a[i][1], b[j][1]);
    if (end - start > EPS) out.push([start, end]);
    if (a[i][1] < b[j][1]) i++;
    else j++;
  }
  return out;
}

// ============================================
// Points and segments
// ============================================

export interface SegmentProjection {
  readonly point: Vector2;
  /** Parameter along `a → b`, clamped to `[0, 1]`. */
  readonly t: number;
  readonly distance: number;
}

export function nearestOnSegment(a: Vector2, b: Vector2, p: Vector2): SegmentProjection {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t =
    lengthSq <= EPS
      ? 0
      : Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  const point = { x: a.x + dx * t, y: a.y + dy * t };
  return { point, t, distance: Math.hypot(p.x - point.x, p.y - point.y) };
}

export function lerp(a: Vector2, b: Vector2, t: number): Vector2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Unit normal of `a → b`, rotated a quarter turn CCW. `null` for a degenerate segment. */
export function segmentNormal(a: Vector2, b: Vector2): Vector2 | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length <= EPS) return null;
  return { x: -dy / length, y: dx / length };
}

/**
 * Where `p→q` meets `r→s`, as the parameter along `p→q`, or `null` if they do not meet.
 *
 * Touching counts: a divider that dead-ends on another divider must still cut it, because that
 * is a T-junction and the two sides of the stem may carry different floors.
 */
export function segmentIntersectionParam(
  p: Vector2,
  q: Vector2,
  r: Vector2,
  s: Vector2
): number | null {
  const dx1 = q.x - p.x;
  const dy1 = q.y - p.y;
  const dx2 = s.x - r.x;
  const dy2 = s.y - r.y;
  const denom = dx1 * dy2 - dy1 * dx2;
  // Parallel, including collinear. A collinear overlap has no single crossing point and the
  // side-probing below reports the same surface on both sides anyway, so there is nothing to cut.
  if (Math.abs(denom) <= EPS) return null;
  const t = ((r.x - p.x) * dy2 - (r.y - p.y) * dx2) / denom;
  const u = ((r.x - p.x) * dy1 - (r.y - p.y) * dx1) / denom;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  return Math.min(1, Math.max(0, t));
}

/**
 * A point strictly inside the ring, used as the stable handle a surface assignment is stored
 * against.
 *
 * The area centroid first, because it is the point a user would call "the middle of this area"
 * and because it moves smoothly when a wall moves — a seed that jumped would re-target the
 * assignment to a different face. A concave ring can put its centroid outside itself (an L), so
 * the fallback scan-lines the ring at the centroid's height and takes the middle of the widest
 * span, which is inside by construction.
 */
export function interiorPoint(polygon: readonly Vector2[]): Vector2 | null {
  if (polygon.length < 3) return null;
  const area = signedArea(polygon);
  if (Math.abs(area) <= EPS) return null;

  let cx = 0;
  let cy = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j];
    const b = polygon[i];
    const cross = a.x * b.y - b.x * a.y;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  const centroid = { x: cx / (6 * area), y: cy / (6 * area) };
  if (pointInPolygon(polygon, centroid)) return centroid;

  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of polygon) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  // The centroid's height first, then a few sweeps — a scan line through a vertex reports an odd
  // number of crossings and yields nothing, so one height is not enough to rely on.
  const heights = [
    centroid.y,
    (minY + maxY) / 2,
    minY + (maxY - minY) / 3,
    maxY - (maxY - minY) / 3,
  ];
  for (const y of heights) {
    let widest: Interval | null = null;
    for (const span of intervalsAt(polygon, y)) {
      if (!widest || span[1] - span[0] > widest[1] - widest[0]) widest = span;
    }
    if (widest) return { x: (widest[0] + widest[1]) / 2, y };
  }
  return null;
}
