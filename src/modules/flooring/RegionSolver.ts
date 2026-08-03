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
  signedArea,
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

function nearestAttachment(ring: readonly Vector2[], p: Vector2): Attachment {
  let best: Attachment = { edge: 0, t: 0, point: ring[0], distance: Infinity };
  for (let i = 0; i < ring.length; i++) {
    const projection = nearestOnSegment(ring[i], ring[(i + 1) % ring.length], p);
    if (projection.distance < best.distance) {
      best = { edge: i, t: projection.t, point: projection.point, distance: projection.distance };
    }
  }
  return best;
}

/**
 * Where the divider's own line meets the ring, nearest to the endpoint `p`.
 *
 * `null` when the line misses the ring entirely, or when `p` and `other` coincide and there is no
 * line to follow.
 *
 * The ray is cast from `other` through `p` and beyond, so a divider that falls short of the wall
 * is *extended* to it and one drawn past it is trimmed back — both along the line the user drew.
 * Crossings are scored by how far they sit from `p` along that line, which is the same quantity
 * the perpendicular attachment reported and so keeps `DIVIDER_ATTACH_TOLERANCE_FT` meaning what
 * it meant. A crossing behind `other` is not a candidate: `other` is the divider's far end, and
 * running past it would attach this end to the wall the other end came from.
 */
function attachAlongLine(ring: readonly Vector2[], p: Vector2, other: Vector2): Attachment | null {
  const dx = p.x - other.x;
  const dy = p.y - other.y;
  const length = Math.hypot(dx, dy);
  if (length <= EPS) return null;
  const ux = dx / length;
  const uy = dy / length;

  let best: Attachment | null = null;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const denom = ux * ey - uy * ex;
    // Parallel, including collinear: a divider lying along a wall has no single crossing with
    // it, and the edges either side of that wall will answer for it.
    if (Math.abs(denom) <= EPS) continue;
    const ax = a.x - other.x;
    const ay = a.y - other.y;
    const s = (ax * ey - ay * ex) / denom;
    const t = (ax * uy - ay * ux) / denom;
    if (s < -EPS || t < -EPS || t > 1 + EPS) continue;
    const distance = Math.abs(s - length);
    if (!best || distance < best.distance) {
      best = {
        edge: i,
        t: Math.min(1, Math.max(0, t)),
        point: { x: other.x + ux * s, y: other.y + uy * s },
        distance,
      };
    }
  }
  return best;
}

/**
 * Where a divider endpoint meets a face's ring.
 *
 * **Along the divider's own line**, not by dropping a perpendicular onto the nearest edge. The
 * difference only shows when the endpoint is not already on the boundary — which is the case the
 * tolerance exists for, since a wall moved after the divider was drawn leaves it floating — and
 * there it is the difference between the chord the user drew and a different line entirely.
 *
 * A perpendicular foot is clamped to the edge it is dropped on, so an endpoint that overshoots a
 * wall's end lands on that wall's *corner*. In a real document an endpoint an inch inside the
 * room attached to the corner beside it and tilted the chord 0.037" off the drawn line over five
 * feet — enough that the expansion gap measured against the transition read 0.247" at one end and
 * 0.217" at the other, against the quarter inch asked for, while being exactly right against the
 * boundary the engine had actually been given.
 *
 * The perpendicular foot is still taken when the endpoint is already on the boundary, where it is
 * exact and the extended line only reproduces it to rounding, and as the fallback when the line
 * misses the ring — a divider aimed away from the face it belongs to still has to attach or be
 * reported unattached, and the nearest point is the honest answer to "where did you mean".
 */
function attach(ring: readonly Vector2[], p: Vector2, other: Vector2): Attachment {
  const nearest = nearestAttachment(ring, p);
  if (nearest.distance <= VERTEX_TOLERANCE_FT) return nearest;
  return attachAlongLine(ring, p, other) ?? nearest;
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
    const a = attach(ring, divider.a, divider.b);
    const b = attach(ring, divider.b, divider.a);
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
  return mergeRings(
    solution.regions.filter((region) => region.surface === DEFAULT_SURFACE).map((r) => r.ring)
  );
}

/**
 * The union of a set of faces of one subdivision, as one ring per connected area.
 *
 * Faces are handed to the engine **merged**, not one per divider, because the engine takes the
 * expansion gap out of every ring it is given. A divider with plank on both sides is not a
 * transition — the module's own definition, see `TransitionSegment` — but two abutting rings each
 * inset by the gap left a bare stripe two gaps wide down the middle of one continuous floor, and
 * a row break along it that ripped boards lengthwise for no visible reason. Merging first is what
 * makes "same surface on both sides" mean nothing at all, which is what it is supposed to mean.
 *
 * The union is by **half-edge cancellation**, which is exact here rather than approximate: every
 * ring is a face of one planar subdivision, so an edge interior to the union appears exactly
 * twice — once in each direction, on the two faces that share it — and the boundary of the union
 * is what is left once those pairs are dropped. That is the whole algorithm; there is no
 * intersection test in it, and so no tolerance to tune beyond deciding when two vertices are the
 * same vertex.
 *
 * Two details earn their keep:
 *
 * - **Rings are normalised to CCW** first. Cancellation needs the shared edge to appear in
 *   opposite directions, which holds for consistently wound faces and fails silently otherwise.
 * - **Edges are split at every vertex lying on them.** A T-junction leaves one face with a long
 *   edge and its two neighbours with two short ones; without the split the long edge has no
 *   partner and survives into the result as a slit.
 *
 * Faces of the chord model always touch the room's boundary — a chord splits one face into two,
 * and each half keeps a piece of its parent's ring — so no union of them can enclose a hole, and
 * a ring is the whole answer.
 */
export function mergeRings(rings: readonly (readonly Vector2[])[]): readonly Vector2[][] {
  if (rings.length === 0) return [];

  // One canonical `Vector2` per distinct position, so "the same vertex" is `===` on a key from
  // here on. The quantum is the one `cleanRing` already treats as coincident.
  const canonical = new Map<string, Vector2>();
  const keyOf = (p: Vector2): string => {
    const key = `${Math.round(p.x * 1e6)}:${Math.round(p.y * 1e6)}`;
    if (!canonical.has(key)) canonical.set(key, p);
    return key;
  };

  const ccw = rings
    .map((ring) => cleanRing(ring))
    .filter((ring) => ring.length >= 3 && polygonArea(ring) > EPS)
    .map((ring) => (signedArea(ring) < 0 ? [...ring].reverse() : ring));
  if (ccw.length === 0) return [];
  if (ccw.length === 1) return [dropCollinear(ccw[0])];

  const vertices = [...new Set(ccw.flatMap((ring) => ring.map(keyOf)))].map(
    (key) => canonical.get(key) as Vector2
  );

  // Directed edges, each already split at every vertex that lies on it.
  const edges: { from: string; to: string }[] = [];
  for (const ring of ccw) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const cuts = vertices
        .map((v) => ({ v, t: nearestOnSegment(a, b, v) }))
        .filter(({ t }) => t.distance <= VERTEX_TOLERANCE_FT && t.t > EPS && t.t < 1 - EPS)
        .sort((p, q) => p.t.t - q.t.t)
        .map(({ v }) => v);
      let previous = a;
      for (const cut of [...cuts, b]) {
        const from = keyOf(previous);
        const to = keyOf(cut);
        if (from !== to) edges.push({ from, to });
        previous = cut;
      }
    }
  }

  // Cancel the interior: an edge with a twin bounds two faces of the union, not the union.
  const present = new Map<string, number>();
  for (const { from, to } of edges) {
    const id = `${from}>${to}`;
    present.set(id, (present.get(id) ?? 0) + 1);
  }
  const outgoing = new Map<string, string[]>();
  for (const { from, to } of edges) {
    const twin = present.get(`${to}>${from}`) ?? 0;
    if (twin > 0) continue;
    const list = outgoing.get(from);
    if (list) list.push(to);
    else outgoing.set(from, [to]);
  }

  // Walk what is left. Every surviving edge is used exactly once, so the walk terminates; the
  // guard is a backstop against a malformed input, not an expected exit.
  const out: Vector2[][] = [];
  const remaining = new Map([...outgoing].map(([from, tos]) => [from, [...tos]]));
  const at = (key: string): Vector2 => canonical.get(key) as Vector2;
  let guard = edges.length + 1;
  for (const start of outgoing.keys()) {
    while ((remaining.get(start) ?? []).length > 0 && guard > 0) {
      const ring: Vector2[] = [];
      let from = start;
      let to = (remaining.get(from) as string[]).shift() as string;
      ring.push(at(from));
      while (to !== start && guard-- > 0) {
        const choices = remaining.get(to) ?? [];
        // Nowhere to go: the input was not a set of faces of one subdivision. Drop the walk
        // rather than close it across open space and pave somewhere there is no floor.
        if (choices.length === 0) {
          ring.length = 0;
          break;
        }
        // At a vertex where two areas meet at a point the walk has a choice, and the most
        // clockwise turn is the one that stays on the area it arrived on.
        const index = choices.length === 1 ? 0 : mostClockwise(at(from), at(to), choices.map(at));
        const next = choices[index];
        choices.splice(index, 1);
        ring.push(at(to));
        from = to;
        to = next;
      }
      if (ring.length >= 3) out.push(dropCollinear(ring));
    }
  }
  return out.filter((ring) => ring.length >= 3 && polygonArea(ring) > EPS);
}

/** Two vertices this close are one vertex — the tolerance `cleanRing` already works to. */
const VERTEX_TOLERANCE_FT = 1e-6;

/**
 * The candidate that turns furthest clockwise from the direction of arrival.
 *
 * Only reached where three or more boundary edges meet at one vertex — two areas of this floor
 * touching at a corner and nowhere else. Keeping right there keeps the walk on the lobe it came
 * in on, so the two lobes come out as two rings instead of one figure-eight whose scan line is
 * nonsense.
 */
function mostClockwise(previous: Vector2, vertex: Vector2, candidates: readonly Vector2[]): number {
  const inX = vertex.x - previous.x;
  const inY = vertex.y - previous.y;
  let best = 0;
  let bestAngle = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const outX = candidates[i].x - vertex.x;
    const outY = candidates[i].y - vertex.y;
    // Clockwise is negative, so the smallest turn is the hardest right.
    const angle = Math.atan2(inX * outY - inY * outX, inX * outX + inY * outY);
    if (angle < bestAngle) {
      bestAngle = angle;
      best = i;
    }
  }
  return best;
}

/**
 * Drop vertices that lie on the line between their neighbours.
 *
 * Splitting every edge at every vertex leaves a straight run of collinear points wherever a
 * divider dead-ends on a wall inside a merged area. They are geometrically harmless — the
 * engine's inset mitres a 180° corner exactly — but they inflate `layoutKey`, so the cache
 * would miss on a document that only looked different.
 */
function dropCollinear(ring: readonly Vector2[]): Vector2[] {
  const out: Vector2[] = [];
  const size = ring.length;
  for (let i = 0; i < size; i++) {
    const a = ring[(i + size - 1) % size];
    const b = ring[i];
    const c = ring[(i + 1) % size];
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const scale = Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(c.x - b.x, c.y - b.y);
    if (scale > EPS && Math.abs(cross) / scale <= VERTEX_TOLERANCE_FT) continue;
    out.push(b);
  }
  return out.length >= 3 ? out : [...ring];
}
