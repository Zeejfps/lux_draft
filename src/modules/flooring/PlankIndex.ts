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
  private readonly cos: number;
  private readonly sin: number;

  private readonly layout: PlankLayout;

  constructor(layout: PlankLayout) {
    this.layout = layout;
    // One cell per plank length: a plank spans at most two cells on each axis, so a point
    // query never needs more than the 3x3 neighbourhood and usually needs one cell.
    const longest = layout.planks.reduce((max, p) => Math.max(max, p.length, p.width), 0);
    this.cell = Math.max(longest, 0.5);
    this.cos = Math.cos(layout.angle);
    this.sin = Math.sin(layout.angle);

    for (const plank of layout.planks) {
      const half = Math.max(plank.length, plank.width) / 2;
      const minX = Math.floor((plank.center.x - half) / this.cell);
      const maxX = Math.floor((plank.center.x + half) / this.cell);
      const minY = Math.floor((plank.center.y - half) / this.cell);
      const maxY = Math.floor((plank.center.y + half) / this.cell);
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

  /** Point-in-rectangle in the plank's own frame — the run angle is shared by every plank. */
  private contains(plank: Plank, point: Vector2): boolean {
    const dx = point.x - plank.center.x;
    const dy = point.y - plank.center.y;
    const along = dx * this.cos + dy * this.sin;
    const across = -dx * this.sin + dy * this.cos;
    return Math.abs(along) <= plank.length / 2 && Math.abs(across) <= plank.width / 2;
  }
}
