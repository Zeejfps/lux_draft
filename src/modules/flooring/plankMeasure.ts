import type { Vector2 } from '../../floorplan/types/geometry';
import { EPS, polygonArea } from './geometry2d';
import type { Plank } from './PlankLayoutEngine';
import { plankProfile } from './PlankLayoutEngine';
import { INCHES_PER_FOOT } from './types';

/**
 * One board's dimensions, taken off the board the way an installer would take them.
 *
 * Read back from `Plank.corners` rather than carried on the plank, because the outline is the
 * geometric truth and a second copy of these figures on every one of several hundred boards is a
 * second thing to keep in step. `PlankLayoutEngine` computes the same three cut figures while it
 * lays the floor — see where it pushes onto `cuts` — and this is that measurement taken for a
 * single board after the fact, so a board picked on the canvas reads the same as its line in the
 * cut list. A test asserts that agreement.
 *
 * Kept out of the engine file for the same reason the engine keeps `PlankIndex` out: this is a
 * consumer of the engine's output, not part of laying a floor, and nothing in the layout path
 * calls it.
 */
export interface PlankMeasurements {
  /** Long point along the run, inches. */
  readonly longIn: number;
  /** Short point along the run, inches. Equal to `longIn` when both ends are square. */
  readonly shortIn: number;
  /** Across-run width, inches — what is left after any rip. */
  readonly widthIn: number;
  /** The steepest cut off square, degrees. `0` when the board is square-cut. */
  readonly angleDeg: number;
  /** The area of the outline itself, square feet — not the long point times the width. */
  readonly areaSqft: number;
  /** True when an end is cut off square, so the short point and the angle say something. */
  readonly mitred: boolean;
}

/**
 * Measure one board.
 *
 * `angle` is the layout's run angle in radians, shared by every plank (`PlankLayout.angle`) — it
 * is what puts the outline back into the board's own frame, where the run is `+x` and the width
 * is `+y`. Measuring in world space instead would give a board on a 30° floor the dimensions of
 * its bounding box, which is not a board anyone cuts.
 */
export function measurePlank(plank: Plank, angle: number): PlankMeasurements {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const local = (p: Vector2): { along: number; across: number } => {
    const dx = p.x - plank.center.x;
    const dy = p.y - plank.center.y;
    return { along: dx * cos + dy * sin, across: -dx * sin + dy * cos };
  };
  const points = plankProfile(plank).map(([start, end]) => ({
    start: local(start),
    end: local(end),
  }));

  const spans = points.map((p) => Math.abs(p.end.along - p.start.along));
  // Per segment, and off the steeper of a bent end's two cuts: an angle is a ratio, and the
  // segment is what the cut actually runs across. Same rule the cut list sets a saw by.
  let steepest = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const rise = Math.abs(points[i + 1].start.across - points[i].start.across);
    // Both ends, because either of them may be the one cut to a diagonal.
    const run = Math.max(
      Math.abs(points[i + 1].start.along - points[i].start.along),
      Math.abs(points[i + 1].end.along - points[i].end.along)
    );
    if (rise > EPS) steepest = Math.max(steepest, Math.atan2(run, rise));
  }

  const longIn = Math.max(...spans) * INCHES_PER_FOOT;
  const shortIn = Math.min(...spans) * INCHES_PER_FOOT;
  return {
    longIn,
    shortIn,
    widthIn: plank.width * INCHES_PER_FOOT,
    angleDeg: (steepest * 180) / Math.PI,
    // The outline's own area, so a piece cut to a diagonal reads the trapezoid it is.
    areaSqft: polygonArea(plank.corners),
    // A mitre that rounds away to nothing is a square cut as far as a saw is concerned — the
    // same call the cut list makes, so the panel does not print a 0.0° mitre on a whole board.
    mitred: longIn - shortIn > 1 / 16,
  };
}
