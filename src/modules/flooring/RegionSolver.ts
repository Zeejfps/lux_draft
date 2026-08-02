import type { Vector2, WallSegment } from '../../floorplan/types/geometry';
import type { Divider, SurfaceAssignment, SurfaceKind, TransitionKind } from './types';
import {
  DEFAULT_SURFACE,
  DIVIDER_ATTACH_TOLERANCE_FT,
  MAX_DIVIDERS,
  SURFACE_PROBE_FT,
} from './types';
import {
  EPS,
  interiorPoint,
  lerp,
  nearestOnSegment,
  pointInPolygon,
  polygonArea,
  segmentIntersectionParam,
  segmentNormal,
} from './geometry2d';

/**
 * `RegionSolver` — a **pure** function of (boundary, dividers, surface assignments) to the areas
 * of the room and the transitions between them.
 *
 * Like `PlankLayoutEngine` it reads no store, no document and no selection, and it imports
 * neither `three` nor `svelte`; unlike the engine it is cheap enough to run on every document
 * emission, which is what lets the panel, the renderer and the layout key all ask the same
 * question and get the same answer.
 *
 * ## Method
 *
 * Faces start as the single ring of the room. Each divider is a **chord** — a segment whose two
 * endpoints reach the boundary of one face — and splitting a ring by a chord is a walk: the
 * chord plus the vertices one way round is the first face, the chord plus the vertices the other
 * way round is the second. One face in, two out, per divider.
 *
 * That is deliberately not a general planar arrangement. An arrangement would also handle a
 * divider that dead-ends in open space or one that crosses three faces at once, at the cost of
 * an intersection sweep, an edge-adjacency structure and the numerical care both need. The chord
 * model covers every plan this editor can draw — a floor changes at a doorway or along a line
 * between two walls — and it fails *loudly*: a divider that reaches nothing is returned in
 * `unattached` for the UI to flag, rather than half-splitting something.
 *
 * A divider whose endpoint lands on an **earlier divider** works, because the earlier divider is
 * an edge of the faces it created. That is the T-junction, and it is the reason the order
 * dividers are stored in is load-bearing: they are applied in document order, and a divider that
 * depends on a later one will not attach. The placement tool appends, so authoring order is
 * dependency order for free.
 *
 * ## What a face is worth
 *
 * Faces are geometry, not identity. The surface a face carries is resolved by containment
 * against `SurfaceAssignment.seed`, and a face with no seed inside it **inherits from the face
 * it was split out of** — so marking a room carpet and then subdividing it leaves both halves
 * carpet, which is what anyone would expect and what a fresh default would get wrong.
 */

// ============================================
// Inputs and outputs
// ============================================

export interface RegionInputs {
  readonly walls: readonly WallSegment[];
  readonly isClosed: boolean;
  readonly dividers: readonly Divider[];
  readonly surfaces: readonly SurfaceAssignment[];
}

export interface FloorRegion {
  /** Closed ring, room coordinates, feet. First vertex is not repeated at the end. */
  readonly ring: readonly Vector2[];
  readonly surface: SurfaceKind;
  /** A point inside the ring. What a `SurfaceAssignment` for this face is stored against. */
  readonly seed: Vector2;
  readonly areaSqft: number;
}

/**
 * One stretch of one divider where the floor actually changes.
 *
 * A divider is not automatically a transition: leave the same surface on both sides and there is
 * nothing to trim. And a single divider can be a transition along only part of its length, where
 * a later divider T-joins it and splits one side in two — hence a *segment*, cut at every
 * crossing, rather than one strip per divider.
 */
export interface TransitionSegment {
  readonly dividerId: string;
  readonly kind: TransitionKind;
  readonly start: Vector2;
  readonly end: Vector2;
  readonly from: SurfaceKind;
  readonly to: SurfaceKind;
}

export interface RegionSolution {
  /** The structural key of the inputs this was solved from. */
  readonly key: string;
  readonly regions: readonly FloorRegion[];
  /** Where the floor changes. Derived — no transition geometry is ever stored. */
  readonly transitions: readonly TransitionSegment[];
  /** Dividers that reached no face boundary. Authored, inert, and worth telling the user about. */
  readonly unattached: readonly string[];
}

export const EMPTY_SOLUTION: RegionSolution = {
  key: 'open',
  regions: [],
  transitions: [],
  unattached: [],
};

// ============================================
// The structural key
// ============================================

const n = (value: number): string => (Math.round(value * 1e6) / 1e6).toString();
const point = (p: Vector2): string => `${n(p.x)},${n(p.y)}`;

/** Canonical, not hashed, for the same reason `layoutKey` is: a collision would draw a lie. */
export function regionInputsKey(inputs: RegionInputs): string {
  if (!inputs.isClosed || inputs.walls.length < 3) return 'open';
  return [
    inputs.walls.map((w) => point(w.start)).join(' '),
    inputs.dividers.map((d) => `${d.id}:${point(d.a)}>${point(d.b)}:${d.kind}`).join('|'),
    inputs.surfaces.map((s) => `${point(s.seed)}=${s.surface}`).join('|'),
  ].join(';');
}

// ============================================
// Splitting a ring by a chord
// ============================================

interface Attachment {
  /** Index of the ring edge `ring[edge] → ring[edge + 1]`. */
  readonly edge: number;
  readonly t: number;
  readonly point: Vector2;
  readonly distance: number;
}

function attach(ring: readonly Vector2[], p: Vector2): Attachment {
  let best: Attachment = { edge: 0, t: 0, point: ring[0], distance: Infinity };
  for (let i = 0; i < ring.length; i++) {
    const projection = nearestOnSegment(ring[i], ring[(i + 1) % ring.length], p);
    if (projection.distance < best.distance) {
      best = { edge: i, t: projection.t, point: projection.point, distance: projection.distance };
    }
  }
  return best;
}

/** Drop consecutive duplicates, which an endpoint landing exactly on a vertex produces. */
function cleanRing(ring: readonly Vector2[]): Vector2[] {
  const out: Vector2[] = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) <= 1e-6) continue;
    out.push(p);
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (out.length > 1 && first && last && Math.hypot(first.x - last.x, first.y - last.y) <= 1e-6) {
    out.pop();
  }
  return out;
}

/**
 * Cut `ring` in two along the chord between `p` and `q`.
 *
 * Both walks start and end on the chord, so both results are closed. `null` when the chord is
 * degenerate — same edge, or an endpoint pair that would leave a face with no area.
 */
function splitRing(
  ring: readonly Vector2[],
  first: Attachment,
  second: Attachment
): [Vector2[], Vector2[]] | null {
  const forward =
    first.edge < second.edge || (first.edge === second.edge && first.t <= second.t)
      ? [first, second]
      : [second, first];
  const [p, q] = forward;
  // A chord with both ends on one edge separates nothing: it is a line lying along a wall.
  if (p.edge === q.edge) return null;

  const size = ring.length;
  const left: Vector2[] = [p.point];
  for (let i = p.edge + 1; i <= q.edge; i++) left.push(ring[i % size]);
  left.push(q.point);

  const right: Vector2[] = [q.point];
  for (let i = q.edge + 1; i <= p.edge + size; i++) right.push(ring[i % size]);
  right.push(p.point);

  const a = cleanRing(left);
  const b = cleanRing(right);
  if (a.length < 3 || b.length < 3) return null;
  if (polygonArea(a) <= EPS || polygonArea(b) <= EPS) return null;
  return [a, b];
}

// ============================================
// The solver
// ============================================

interface Face {
  ring: readonly Vector2[];
  surface: SurfaceKind;
}

/** The surface an explicit assignment gives this ring, or `null` when none falls inside it. */
function assignedSurface(
  ring: readonly Vector2[],
  surfaces: readonly SurfaceAssignment[]
): SurfaceKind | null {
  for (const assignment of surfaces) {
    if (pointInPolygon(ring, assignment.seed)) return assignment.surface;
  }
  return null;
}

/** Where a divider ended up once projected onto the face it split. */
interface PlacedDivider {
  readonly divider: Divider;
  readonly a: Vector2;
  readonly b: Vector2;
}

export function solveRegions(inputs: RegionInputs): RegionSolution {
  const key = regionInputsKey(inputs);
  const { walls, isClosed, dividers, surfaces } = inputs;
  if (!isClosed || walls.length < 3) return { ...EMPTY_SOLUTION, key };

  const boundary = cleanRing(walls.map((wall) => wall.start));
  if (boundary.length < 3 || polygonArea(boundary) <= EPS) return { ...EMPTY_SOLUTION, key };

  // The undivided room takes an assignment; a room that is about to be split does not. Every
  // seed is inside the whole room by definition, so letting the root claim one would paint the
  // entire floor carpet on the strength of a seed that belongs to one corner of it — and then
  // inheritance would carry that everywhere. Once there is a divider, each face resolves from
  // the seed that is actually inside it.
  const undivided = dividers.length === 0;
  const faces: Face[] = [
    {
      ring: boundary,
      surface: (undivided ? assignedSurface(boundary, surfaces) : null) ?? DEFAULT_SURFACE,
    },
  ];
  const placed: PlacedDivider[] = [];
  const unattached: string[] = [];

  for (const divider of dividers.slice(0, MAX_DIVIDERS)) {
    const target = locateFace(faces, divider);
    if (!target) {
      unattached.push(divider.id);
      continue;
    }
    const { index, a, b } = target;
    const parent = faces[index];
    const halves = splitRing(parent.ring, a, b);
    if (!halves) {
      unattached.push(divider.id);
      continue;
    }
    // Inherit, then let an explicit seed override. This is what keeps a subdivided carpet area
    // carpet on both sides of the new line.
    const children: Face[] = halves.map((ring) => ({
      ring,
      surface: assignedSurface(ring, surfaces) ?? parent.surface,
    }));
    faces.splice(index, 1, ...children);
    placed.push({ divider, a: a.point, b: b.point });
  }

  const regions: FloorRegion[] = [];
  for (const face of faces) {
    const seed = interiorPoint(face.ring);
    if (!seed) continue;
    regions.push({
      ring: face.ring,
      surface: face.surface,
      seed,
      areaSqft: polygonArea(face.ring),
    });
  }

  return { key, regions, transitions: transitionsOf(placed, regions), unattached };
}

/**
 * The face this divider cuts, with both endpoints projected onto its ring.
 *
 * Both ends must be within tolerance of the *same* face, and the chord's midpoint must be inside
 * it — otherwise a divider lying along a shared edge would match both faces that share it, and
 * whichever came first would win by accident.
 */
function locateFace(
  faces: readonly Face[],
  divider: Divider
): { index: number; a: Attachment; b: Attachment } | null {
  let best: { index: number; a: Attachment; b: Attachment; distance: number } | null = null;
  for (let index = 0; index < faces.length; index++) {
    const ring = faces[index].ring;
    const a = attach(ring, divider.a);
    const b = attach(ring, divider.b);
    if (a.distance > DIVIDER_ATTACH_TOLERANCE_FT || b.distance > DIVIDER_ATTACH_TOLERANCE_FT) {
      continue;
    }
    const midpoint = lerp(a.point, b.point, 0.5);
    if (!pointInPolygon(ring, midpoint)) continue;
    const distance = a.distance + b.distance;
    if (!best || distance < best.distance) best = { index, a, b, distance };
  }
  return best ? { index: best.index, a: best.a, b: best.b } : null;
}

/**
 * Cut every divider at its crossings with the others, then read the surface on each side.
 *
 * Sampling rather than bookkeeping: a face edge that came from a divider is geometrically
 * identical to one that came from a wall, and tracking provenance through the split would have
 * to survive a later split cutting that edge in half. Probing `SURFACE_PROBE_FT` either side of
 * a sub-segment's midpoint asks the question the user is actually asking — "what is on this side
 * of this line" — and costs a point-in-polygon per face.
 */
function transitionsOf(
  placed: readonly PlacedDivider[],
  regions: readonly FloorRegion[]
): TransitionSegment[] {
  const surfaceAt = (p: Vector2): SurfaceKind => {
    for (const region of regions) {
      if (pointInPolygon(region.ring, p)) return region.surface;
    }
    return 'none';
  };

  const out: TransitionSegment[] = [];
  for (const { divider, a, b } of placed) {
    const normal = segmentNormal(a, b);
    if (!normal) continue;

    const cuts = [0, 1];
    for (const other of placed) {
      if (other.divider.id === divider.id) continue;
      const t = segmentIntersectionParam(a, b, other.a, other.b);
      if (t !== null) cuts.push(t);
    }
    cuts.sort((p, q) => p - q);

    for (let i = 0; i + 1 < cuts.length; i++) {
      const [t0, t1] = [cuts[i], cuts[i + 1]];
      if (t1 - t0 <= 1e-6) continue;
      const mid = lerp(a, b, (t0 + t1) / 2);
      const from = surfaceAt({
        x: mid.x + normal.x * SURFACE_PROBE_FT,
        y: mid.y + normal.y * SURFACE_PROBE_FT,
      });
      const to = surfaceAt({
        x: mid.x - normal.x * SURFACE_PROBE_FT,
        y: mid.y - normal.y * SURFACE_PROBE_FT,
      });
      if (from === to) continue;
      out.push({
        dividerId: divider.id,
        kind: divider.kind,
        start: lerp(a, b, t0),
        end: lerp(a, b, t1),
        from,
        to,
      });
    }
  }
  return out;
}

// ============================================
// What the engine consumes
// ============================================

/**
 * The rings this module actually lays plank over, or `null` for "the whole room".
 *
 * `null` rather than "every ring" is not an optimisation detail, it is the back-compatible
 * case made explicit: a document with no dividers must produce the identical floor it produced
 * before dividers existed, and the identical `layoutKey` with it. An **empty array** is the
 * opposite and equally meaningful — every area has been assigned to something else, so no plank
 * is laid.
 */
export function plankRings(solution: RegionSolution): readonly (readonly Vector2[])[] | null {
  if (solution.regions.length === 0) return null;
  if (solution.regions.every((region) => region.surface === DEFAULT_SURFACE)) return null;
  return solution.regions
    .filter((region) => region.surface === DEFAULT_SURFACE)
    .map((region) => region.ring);
}
