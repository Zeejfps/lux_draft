import type { Vector2 } from '../../floorplan/types/geometry';
import type { Plank, PlankLayout } from './PlankLayoutEngine';

/**
 * A uniform-grid spatial index over a derived floor.
 *
 * Built with the layout rather than retrofitted onto it, for the reason the plan gives: a 400
 * sqft floor at 7" x 48" is ~200 planks and a 900 sqft great room at 5" x 36" is over 700, and
 * a linear scan on every `mousemove` is a scan of every plank at 60 Hz. The grid turns that into
 * "look in one cell", which is a handful of candidates whatever the floor's size.
 *
 * Pure and free of `three`: it indexes the engine's output, which is plain data.
 */
export class PlankIndex {
  private readonly cells = new Map<string, Plank[]>();
  private readonly cell: number;

  private readonly layout: PlankLayout;

  constructor(layout: PlankLayout) {
    this.layout = layout;
    // One cell per plank length: a plank spans at most two cells on each axis, so a point
    // query never needs more than the 3x3 neighbourhood and usually needs one cell.
    const longest = layout.planks.reduce((max, p) => Math.max(max, p.length, p.width), 0);
    this.cell = Math.max(longest, 0.5);

    for (const plank of layout.planks) {
      // The corners are the bounding box directly — a mitred piece is a quad, and the
      // rectangle about its centre is not a bound on it.
      const xs = plank.corners.map((c) => c.x);
      const ys = plank.corners.map((c) => c.y);
      const minX = Math.floor(Math.min(...xs) / this.cell);
      const maxX = Math.floor(Math.max(...xs) / this.cell);
      const minY = Math.floor(Math.min(...ys) / this.cell);
      const maxY = Math.floor(Math.max(...ys) / this.cell);
      for (let cx = minX; cx <= maxX; cx++) {
        for (let cy = minY; cy <= maxY; cy++) {
          const key = `${cx}:${cy}`;
          const bucket = this.cells.get(key);
          if (bucket) bucket.push(plank);
          else this.cells.set(key, [plank]);
        }
      }
    }
  }

  /** The plank containing this world-space point, or null. */
  at(point: Vector2): Plank | null {
    const cx = Math.floor(point.x / this.cell);
    const cy = Math.floor(point.y / this.cell);
    for (const plank of this.cells.get(`${cx}:${cy}`) ?? []) {
      if (this.contains(plank, point)) return plank;
    }
    return null;
  }

  get size(): number {
    return this.layout.planks.length;
  }

  /**
   * Point-in-quad, against the four half-planes of `corners`.
   *
   * Not point-in-rectangle in the plank's own frame: a piece cut to a diagonal boundary is a
   * trapezoid, and the nominal rectangle would both claim the wedge outside the wall and miss
   * nothing — so hovering just past the wall would light up a board that is not there. The sign
   * is taken from the quad's own winding, which the mirrored start corners reverse; a degenerate
   * edge (the triangle case, where two corners coincide) contributes a zero and is ignored.
   */
  private contains(plank: Plank, point: Vector2): boolean {
    let positive = false;
    let negative = false;
    const corners = plank.corners;
    for (let i = 0; i < 4; i++) {
      const a = corners[i];
      const b = corners[(i + 1) % 4];
      const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
      if (cross > 1e-9) positive = true;
      else if (cross < -1e-9) negative = true;
      if (positive && negative) return false;
    }
    return true;
  }
}
