import { describe, it, expect } from 'vitest';
import type { Obstacle, Vector2, WallSegment } from '../../../src/floorplan/types/geometry';
import type { LayoutInputs } from '../../../src/modules/flooring/PlankLayoutEngine';
import {
  computePlankLayout,
  layoutKey,
  plankProfile,
} from '../../../src/modules/flooring/PlankLayoutEngine';
import { PlankIndex } from '../../../src/modules/flooring/PlankIndex';
import { defaultFlooringData } from '../../../src/modules/flooring/codec';
import { interiorPoint, pointInPolygon } from '../../../src/modules/flooring/geometry2d';
import type { LayoutConfig, PlankSpec, StaggerRule } from '../../../src/modules/flooring/types';
import { INCHES_PER_FOOT, MIN_JOINT_OFFSET_IN } from '../../../src/modules/flooring/types';
import { makeObstacle, rectWalls } from '../../helpers/documents';

/**
 * The engine as a pure table: no store, no Svelte, no DOM, no THREE.
 *
 * Everything asserted here is a property of `(boundary, obstacles, plank, layout, origin)`, and
 * nothing here constructs a document — which is the whole claim about derived data. If any of
 * these needed a session to run, the layout would not be a projection.
 */

const defaults = defaultFlooringData();

function inputs(over: Partial<LayoutInputs> = {}): LayoutInputs {
  return {
    walls: rectWalls(20, 20),
    isClosed: true,
    obstacles: [],
    plank: defaults.plank,
    layout: defaults.layout,
    origin: defaults.origin,
    ...over,
  };
}

const layoutOf = (config: Partial<LayoutConfig>, over: Partial<LayoutInputs> = {}) =>
  computePlankLayout(inputs({ layout: { ...defaults.layout, ...config }, ...over }));

/** The corners of a `w` x `h` room at the origin, as a closed ring. */
const ring = (w: number, h: number): Vector2[] => [
  { x: 0, y: 0 },
  { x: w, y: 0 },
  { x: w, y: h },
  { x: 0, y: h },
];

function wallsOf(corners: readonly Vector2[]): WallSegment[] {
  return corners.map((start, i) => {
    const end = corners[(i + 1) % corners.length];
    return { id: `w${i}`, start, end, length: Math.hypot(end.x - start.x, end.y - start.y) };
  });
}

/**
 * How far `p` sits inside `polygon` — negative when it is outside it.
 *
 * The one measurement the whole plan is about: the expansion gap is a distance from *every*
 * boundary, so it has to be checked against the outline itself rather than against a bounding
 * box or an axis.
 */
function clearance(polygon: readonly Vector2[], p: Vector2): number {
  let best = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return pointInPolygon(polygon, p) ? best : -best;
}

describe('a room with no floor', () => {
  it('lays nothing on an open boundary', () => {
    expect(computePlankLayout(inputs({ isClosed: false })).planks).toHaveLength(0);
  });

  it('lays nothing on fewer than three walls', () => {
    expect(
      computePlankLayout(inputs({ walls: rectWalls(10, 10).slice(0, 2) })).planks
    ).toHaveLength(0);
  });

  it('lays nothing for a degenerate plank', () => {
    const plank: PlankSpec = { widthIn: 0, lengthIn: 48, name: 'bad', minRipWidthIn: 2 };
    expect(computePlankLayout(inputs({ plank })).planks).toHaveLength(0);
  });

  /**
   * A non-finite number passes every ordered comparison in the engine — including the bound on
   * `rowCount` — so without the guard these produce a floor of planks whose every corner is
   * `NaN`: invisible, unhittable, and a cut list of lengths no saw can be set to. The codec
   * rejects all of them at the document boundary; the engine is public and pure, so it rejects
   * them again here.
   */
  describe.each([Number.NaN, Number.POSITIVE_INFINITY])('a non-finite input (%p)', (bad) => {
    it('lays nothing for a plank dimension', () => {
      const plank: PlankSpec = { widthIn: bad, lengthIn: 48, name: 'bad', minRipWidthIn: 2 };
      expect(computePlankLayout(inputs({ plank })).planks).toHaveLength(0);
      expect(
        computePlankLayout(inputs({ plank: { ...plank, widthIn: 7, lengthIn: bad } })).planks
      ).toHaveLength(0);
    });

    it('lays nothing for an origin', () => {
      expect(computePlankLayout(inputs({ origin: { x: bad, y: 0 } })).planks).toHaveLength(0);
      expect(computePlankLayout(inputs({ origin: { x: 0, y: bad } })).planks).toHaveLength(0);
    });

    it.each(['runAngleDeg', 'expansionGapIn', 'minEndCutIn'] as const)(
      'lays nothing for %s',
      (field) => {
        expect(layoutOf({ [field]: bad }).planks).toHaveLength(0);
      }
    );

    it('lays nothing for a row offset pattern entry', () => {
      expect(layoutOf({ stagger: 'pattern', rowOffsetPattern: [0, bad] }).planks).toHaveLength(0);
    });
  });

  /** `hashFraction` truncates the seed, so a non-finite one is a defined floor, not a broken one. */
  it('still lays a floor for a non-finite random seed', () => {
    expect(layoutOf({ stagger: 'random', seed: Number.NaN }).planks.length).toBeGreaterThan(0);
  });
});

describe('coverage', () => {
  it('covers a rectangular room to within the expansion gap', () => {
    const layout = layoutOf({ expansionGapIn: 0 });
    // 20 x 20 with no gap: rows tile the height exactly, planks tile each row exactly.
    expect(layout.coveredSqft).toBeCloseTo(400, 1);
  });

  it('the expansion gap comes off the covered area, not out of nowhere', () => {
    const withGap = layoutOf({ expansionGapIn: 0.5 });
    const without = layoutOf({ expansionGapIn: 0 });
    expect(withGap.coveredSqft).toBeLessThan(without.coveredSqft);
    // The gap is a perimeter inset, so what is lost is the 20x20 room less the 19 11/12 square
    // that is left after half an inch comes off all four walls — not a strip on two of them.
    const inset = 20 - 2 * (0.5 / 12);
    expect(without.coveredSqft - withGap.coveredSqft).toBeCloseTo(400 - inset * inset, 1);
  });

  it('an obstacle is a cutout, with no code in this module that knows what an obstacle is', () => {
    const island: Obstacle = makeObstacle('island', { x: 6, y: 6 }, 4);
    const clear = layoutOf({});
    const around = layoutOf({}, { obstacles: [island] });
    // A 4x4 island removes 16 sq ft, less the part of each row it only partly covers.
    expect(clear.coveredSqft - around.coveredSqft).toBeGreaterThan(13);
    expect(clear.coveredSqft - around.coveredSqft).toBeLessThan(17);
  });

  it('a concave room is handled by the scan line, not by convex clipping', () => {
    // An L: 20x20 with the top-right 10x10 removed.
    const corners: Vector2[] = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 10 },
      { x: 10, y: 10 },
      { x: 10, y: 20 },
      { x: 0, y: 20 },
    ];
    const walls: WallSegment[] = corners.map((start, i) => {
      const end = corners[(i + 1) % corners.length];
      return {
        id: `w${i}`,
        start,
        end,
        length: Math.hypot(end.x - start.x, end.y - start.y),
      };
    });
    const layout = computePlankLayout(
      inputs({ walls, layout: { ...defaults.layout, expansionGapIn: 0 } })
    );
    // Exactly 300 sq ft. The band that would straddle the inside step is split at it, so no row
    // is laid as if all of it looked like its centreline and nothing is left over to under-report.
    expect(layout.coveredSqft).toBeCloseTo(300, 6);
  });

  it('does not rip a whole row just because one corner of the room is in it', () => {
    /**
     * The artefact this guards, and it has been shipped twice: a band is split at every height
     * an outline turns, but the split runs the whole width of the room while the vertex only
     * changes the boundary at its own x. Emitted straight out, one room corner rips every board
     * in its row from wall to wall — a lengthwise seam fixed in world space, immune to the plank
     * width and to the layout origin, which is exactly how a user finds it.
     *
     * The L's inside corner is at y = 10. Boards in that row to the *left* of the step have room
     * above and below and must come out full width; only the ones to the right, which have
     * nothing above them, are ripped.
     */
    const corners: Vector2[] = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 10 },
      { x: 10, y: 10 },
      { x: 10, y: 20 },
      { x: 0, y: 20 },
    ];
    const full = 7 / 12;
    for (const originY of [0, 0.19, 0.31, 0.42]) {
      const layout = computePlankLayout(
        inputs({
          walls: wallsOf(corners),
          origin: { x: 0, y: originY },
          layout: { ...defaults.layout, expansionGapIn: 0 },
        })
      );
      // Left of the step and clear of the walls at y = 0 and y = 20, which do rip their rows.
      const clearOfTheStep = layout.planks.filter(
        (p) => p.center.x + p.length / 2 <= 10 + 1e-9 && p.center.y > 1 && p.center.y < 19
      );
      expect(clearOfTheStep.length).toBeGreaterThan(20);
      for (const plank of clearOfTheStep) {
        expect(plank.width).toBeCloseTo(full, 9);
      }
      // The counterpart, so this cannot pass by refusing to rip anything. Away from the walls at
      // y = 0 and y = 20 the only rip in this room is the one the step makes, and every board it
      // makes lies wholly *beyond* the step, where there is no floor above to join to. None of
      // the chosen origins puts y = 10 on a row line, so there is always such a rip to find.
      const ripped = layout.planks.filter(
        (p) => p.width < full - 1e-9 && p.center.y > 1 && p.center.y < 19
      );
      expect(ripped.length).toBeGreaterThan(0);
      for (const plank of ripped) {
        expect(plank.center.x - plank.length / 2).toBeGreaterThan(10 - 1e-9);
      }
    }
  });

  it('rips the last row rather than dropping it', () => {
    // 20 ft of height is 34.28 rows of 7": the last row must be ripped to 2", not skipped.
    const layout = layoutOf({ expansionGapIn: 0 });
    const widths = new Set(layout.planks.map((p) => p.width.toFixed(6)));
    expect(widths.size).toBe(2);
    expect(Math.min(...[...widths].map(Number)) * 12).toBeCloseTo(2, 4);
  });
});

describe('the expansion gap', () => {
  /** Bounds of every piece in world space. Run angle 0 from the bottom-left: run +x, rows +y. */
  function bounds(planks: readonly { center: Vector2; length: number; width: number }[]) {
    return {
      minX: Math.min(...planks.map((p) => p.center.x - p.length / 2)),
      maxX: Math.max(...planks.map((p) => p.center.x + p.length / 2)),
      minY: Math.min(...planks.map((p) => p.center.y - p.width / 2)),
      maxY: Math.max(...planks.map((p) => p.center.y + p.width / 2)),
    };
  }

  const GAP_IN = 0.5;
  const gap = GAP_IN / 12;

  it('holds the floor off all four walls, not just the two the rows end at', () => {
    const { minX, maxX, minY, maxY } = bounds(layoutOf({ expansionGapIn: GAP_IN }).planks);
    // A floating floor with no gap on one axis buckles on that axis, so the rows are held off
    // the walls they run parallel to (y) exactly as far as the walls they end at (x).
    expect(minX).toBeCloseTo(gap, 6);
    expect(maxX).toBeCloseTo(20 - gap, 6);
    expect(minY).toBeCloseTo(gap, 6);
    expect(maxY).toBeCloseTo(20 - gap, 6);
  });

  it('holds it off the inside walls of a concave room too', () => {
    // The same L as above: the step at y = 10 is an outside wall of the floor, and the run is
    // parallel to it, so an inset of the extent alone would miss it.
    const corners: Vector2[] = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 10 },
      { x: 10, y: 10 },
      { x: 10, y: 20 },
      { x: 0, y: 20 },
    ];
    const walls: WallSegment[] = corners.map((start, i) => {
      const end = corners[(i + 1) % corners.length];
      return { id: `w${i}`, start, end, length: Math.hypot(end.x - start.x, end.y - start.y) };
    });
    const layout = computePlankLayout(
      inputs({ walls, layout: { ...defaults.layout, expansionGapIn: GAP_IN } })
    );
    // Nothing in the removed quadrant, and nothing within the gap of the step or of the wall
    // that climbs from it.
    for (const plank of layout.planks) {
      const right = plank.center.x + plank.length / 2;
      const top = plank.center.y + plank.width / 2;
      if (top > 10) expect(right).toBeLessThanOrEqual(10 - gap + 1e-6);
    }
  });

  it('stops the planks short of an obstacle on every side of it', () => {
    // The island spans [6, 10] on both axes; the cutout it leaves is that grown by the gap.
    const island: Obstacle = makeObstacle('island', { x: 6, y: 6 }, 4);
    const layout = layoutOf({ expansionGapIn: GAP_IN }, { obstacles: [island] });
    for (const plank of layout.planks) {
      // A row is sampled on its centreline, so that is where the cutout is exact.
      const y = plank.center.y;
      if (y <= 6 - gap || y >= 10 + gap) continue;
      const left = plank.center.x - plank.length / 2;
      const right = plank.center.x + plank.length / 2;
      expect(right <= 6 - gap + 1e-6 || left >= 10 + gap - 1e-6).toBe(true);
    }
    // And the rows that pass over the island are held off its faces, not laid up against them.
    const overIsland = layout.planks
      .filter((p) => p.center.x - p.length / 2 < 8 && p.center.x + p.length / 2 > 8)
      .map((p) => p.center.y);
    expect(Math.min(...overIsland.filter((y) => y > 10))).toBeGreaterThan(10 + gap);
    expect(Math.max(...overIsland.filter((y) => y < 6))).toBeLessThan(6 - gap);
  });

  it('measures the gap from a diagonal wall, not along the row', () => {
    // A run at 45 degrees to the walls. Trimming the interval would have backed the row off by
    // gap / cos 45; moving the wall along its own normal backs it off by the gap.
    const layout = layoutOf({ expansionGapIn: GAP_IN, runAngleDeg: 45 });
    const corners = layout.planks.flatMap((p) => [...p.corners]);
    expect(Math.min(...corners.map((c) => clearance(ring(20, 20), c)))).toBeCloseTo(gap, 6);
  });

  /**
   * The defect the boundary-cut plan was written for, as a property.
   *
   * A row used to be sampled on one scan line and emitted as an axis-aligned rectangle in the
   * run frame, so where the boundary was neither parallel nor perpendicular to the run, half the
   * board hung past the wall and the other half left a wedge of bare subfloor. The measured
   * minimum clearance from any plank corner to a wall in a 12 x 10 room at 7" x 48" with a 3"
   * gap ran: 3.000" at 0°, 3.000" at 90°, 0.525" at 45°, **−0.031"** at 30°, **−0.381"** at 15°.
   * Negative is outside the room — and a rotated run makes *every* wall diagonal in the run
   * frame, so this was every floor laid at an angle, not an oddly shaped room.
   */
  describe('every corner is cut to the boundary it meets', () => {
    const GAP = 3;
    const gapFt = GAP / 12;

    const cornersOf = (walls: WallSegment[], runAngleDeg: number): Vector2[] =>
      computePlankLayout(
        inputs({ walls, layout: { ...defaults.layout, expansionGapIn: GAP, runAngleDeg } })
      ).planks.flatMap((p) => [...p.corners]);

    it('holds the gap off every wall at every run angle', () => {
      const room = ring(12, 10);
      for (let angle = 0; angle <= 90; angle += 5) {
        const corners = cornersOf(wallsOf(room), angle);
        expect(corners.length).toBeGreaterThan(0);
        const closest = Math.min(...corners.map((c) => clearance(room, c)));
        // At the gap, not merely inside the room: a corner short of it is a board hanging over
        // the wall, a corner well past it is a wedge of bare subfloor.
        expect(closest).toBeGreaterThan(gapFt - 1e-6);
        expect(closest).toBeLessThan(gapFt + 1e-6);
      }
    });

    it('holds it off a diagonal wall the run is not aligned to either', () => {
      // Two walls off square, so no run angle can make the room rectilinear in the run frame.
      const room: Vector2[] = [
        { x: 0, y: 0 },
        { x: 14, y: 0 },
        { x: 18, y: 6 },
        { x: 10, y: 12 },
        { x: 0, y: 9 },
      ];
      for (const angle of [0, 17, 45, 63]) {
        const corners = cornersOf(wallsOf(room), angle);
        expect(corners.length).toBeGreaterThan(0);
        const closest = Math.min(...corners.map((c) => clearance(room, c)));
        expect(closest).toBeGreaterThan(gapFt - 1e-6);
        expect(closest).toBeLessThan(gapFt + 1e-6);
      }
    });

    /**
     * The mitre used to be capped at four gaps, to stop a vertex shooting off as a corner
     * approaches a spike. The inward mitre's reach is `gap / sin(θ/2)`, so that cap fired for
     * **every corner sharper than 29°** — and it fired by dragging the vertex back toward the
     * corner, leaving it `4 · gap · sin(θ/2)` from the two walls that meet there instead of
     * `gap`. Measured on an 8.5° wedge at a quarter-inch gap: 0.075" at a square run and 0.0006"
     * at 45°, against the quarter inch asked for. The boards crept toward the wall as the corner
     * narrowed, which is what a floor buckling at a transition looks like on a drawing.
     *
     * There is no cap that avoids it: the mitre point is where the two offset lines cross, which
     * *is* the set of points a gap from both edges, so pulling it in by any amount closes one of
     * the two gaps by the same amount.
     */
    it('holds the gap into a corner far sharper than a mitre cap would allow', () => {
      // A wedge of 8.5°: a 20 x 20 room cut by a chord from (0, 17) to the far top corner.
      const wedge: Vector2[] = [
        { x: 20, y: 20 },
        { x: 0, y: 20 },
        { x: 0, y: 17 },
      ];
      for (const angle of [0, 45, 90]) {
        const corners = computePlankLayout(
          inputs({
            layout: { ...defaults.layout, expansionGapIn: GAP, runAngleDeg: angle },
            regions: [wedge],
          })
        ).planks.flatMap((p) => [...p.corners]);
        expect(corners.length, `angle ${angle}`).toBeGreaterThan(0);
        const closest = Math.min(...corners.map((c) => clearance(wedge, c)));
        expect(closest, `angle ${angle}`).toBeGreaterThan(gapFt - 1e-6);
      }
    });

    it('reports the area it actually laid, trapezoids included', () => {
      // A right triangle of legs 12 and 9, laid at 30° — every wall diagonal in the run frame,
      // and the hypotenuse diagonal in any frame. Nothing left approximate means the covered
      // area is the inset triangle's, not a count of whole rectangles.
      const room: Vector2[] = [
        { x: 0, y: 0 },
        { x: 12, y: 0 },
        { x: 0, y: 9 },
      ];
      const layout = computePlankLayout(
        inputs({
          walls: wallsOf(room),
          layout: { ...defaults.layout, expansionGapIn: 0, runAngleDeg: 30 },
        })
      );
      expect(layout.coveredSqft).toBeCloseTo(54, 6);
    });
  });

  it('a gap wider than the room leaves no floor rather than an inside-out one', () => {
    const layout = computePlankLayout(
      inputs({
        walls: rectWalls(1, 1),
        layout: { ...defaults.layout, expansionGapIn: 12 },
      })
    );
    expect(layout.planks).toHaveLength(0);
    expect(layout.coveredSqft).toBe(0);
  });
});

describe('the origin against the expansion gap', () => {
  /**
   * The origin is the corner the installer measures from — a corner of the *room*. The floor
   * starts one gap in from it, so a grid anchored at the raw origin put the first row's edge one
   * gap behind the floor: the row against the start wall came out `plankWidth - gap` wide and the
   * first board `plankLength - gap` long, and dragging the origin swept that sliver through every
   * width from nothing to a full board.
   */
  const GAP_IN = 3;

  const startCorner = (over: Partial<LayoutConfig> = {}) => {
    const layout = layoutOf({ expansionGapIn: GAP_IN, stagger: 'none', ...over });
    const first = [...layout.planks].sort(
      (a, b) => a.center.y - b.center.y || a.center.x - b.center.x
    )[0];
    return {
      width: first.width * 12,
      length: first.length * 12,
      left: (first.center.x - first.length / 2) * 12,
      bottom: (first.center.y - first.width / 2) * 12,
    };
  };

  it('starts the grid one gap in from the origin, so the first board is a whole one', () => {
    // Origin on the room corner (0,0): gap, then a full board, in both directions.
    const first = startCorner();
    expect(first.left).toBeCloseTo(GAP_IN, 6);
    expect(first.bottom).toBeCloseTo(GAP_IN, 6);
    expect(first.width).toBeCloseTo(defaults.plank.widthIn, 6);
    expect(first.length).toBeCloseTo(defaults.plank.lengthIn, 6);
  });

  it('still leaves the gap when the origin is nowhere near a corner', () => {
    const layout = layoutOf({ expansionGapIn: GAP_IN }, { origin: { x: 6.3, y: 4.1 } });
    const gap = GAP_IN / 12;
    for (const plank of layout.planks) {
      expect(plank.center.x - plank.length / 2).toBeGreaterThanOrEqual(gap - 1e-6);
      expect(plank.center.x + plank.length / 2).toBeLessThanOrEqual(20 - gap + 1e-6);
      expect(plank.center.y - plank.width / 2).toBeGreaterThanOrEqual(gap - 1e-6);
      expect(plank.center.y + plank.width / 2).toBeLessThanOrEqual(20 - gap + 1e-6);
    }
  });

  it('still moves every joint when the origin moves', () => {
    const a = layoutOf({ expansionGapIn: GAP_IN, stagger: 'none' });
    const b = computePlankLayout(
      inputs({
        layout: { ...defaults.layout, expansionGapIn: GAP_IN, stagger: 'none' },
        origin: { x: 0.7, y: 0.3 },
      })
    );
    expect(a.key).not.toBe(b.key);
    const jointsOf = (layout: typeof a) =>
      new Set(layout.planks.map((p) => (p.center.x + p.length / 2).toFixed(4)));
    expect([...jointsOf(a)]).not.toEqual([...jointsOf(b)]);
  });

  it('holds the gap whichever corner the run starts from', () => {
    for (const corner of ['bottomLeft', 'bottomRight', 'topLeft', 'topRight'] as const) {
      const first = startCorner({ startCorner: corner });
      expect(first.width).toBeCloseTo(defaults.plank.widthIn, 6);
      expect(first.length).toBeCloseTo(defaults.plank.lengthIn, 6);
    }
  });
});

describe('stagger', () => {
  const startsOfRow = (config: Partial<LayoutConfig>): Map<number, number> => {
    const layout = layoutOf(config);
    const firstJoint = new Map<number, number>();
    for (const plank of layout.planks) {
      if (plank.column !== 0) continue;
      // The far end of the first plank in the row is the row's first joint.
      firstJoint.set(plank.row, plank.center.x + plank.length / 2);
    }
    return firstJoint;
  };

  it('none puts every row on the same joint', () => {
    const joints = [...startsOfRow({ stagger: 'none', expansionGapIn: 0 }).values()];
    expect(new Set(joints.map((j) => j.toFixed(4))).size).toBe(1);
  });

  it('half alternates between two joints', () => {
    const joints = [...startsOfRow({ stagger: 'half', expansionGapIn: 0 }).values()];
    expect(new Set(joints.map((j) => j.toFixed(4))).size).toBe(2);
  });

  it('thirds cycles three', () => {
    const joints = [...startsOfRow({ stagger: 'thirds', expansionGapIn: 0 }).values()];
    expect(new Set(joints.map((j) => j.toFixed(4))).size).toBe(3);
  });

  it('random is deterministic in the seed, so the layout is still a pure function', () => {
    const a = layoutOf({ stagger: 'random', seed: 42 });
    const b = layoutOf({ stagger: 'random', seed: 42 });
    const c = layoutOf({ stagger: 'random', seed: 43 });
    expect(a.planks.map((p) => p.length)).toEqual(b.planks.map((p) => p.length));
    expect(a.planks.map((p) => p.length)).not.toEqual(c.planks.map((p) => p.length));
  });

  it('a custom pattern cycles its own length', () => {
    const joints = [
      ...startsOfRow({
        stagger: 'pattern',
        rowOffsetPattern: [0, 0.2, 0.4, 0.6],
        expansionGapIn: 0,
      }).values(),
    ];
    expect(new Set(joints.map((j) => j.toFixed(4))).size).toBe(4);
  });
});

describe('the minimum end cut', () => {
  it('shifts the row rather than leaving a sliver', () => {
    // 20 ft rows, 4 ft planks, aligned: every row would end exactly on a joint with no sliver,
    // so nudge the origin to force a short end piece.
    const short = layoutOf(
      { stagger: 'none', expansionGapIn: 0, minEndCutIn: 0 },
      { origin: { x: 0.1, y: 0 } }
    );
    const enforced = layoutOf(
      { stagger: 'none', expansionGapIn: 0, minEndCutIn: 8 },
      { origin: { x: 0.1, y: 0 } }
    );

    const shortestOf = (planks: readonly { length: number }[]) =>
      Math.min(...planks.map((p) => p.length));

    expect(shortestOf(short.planks) * 12).toBeLessThan(8);
    expect(shortestOf(enforced.planks) * 12).toBeGreaterThanOrEqual(8 - 1e-6);
    // Nothing was invented or thrown away to do it.
    expect(enforced.coveredSqft).toBeCloseTo(short.coveredSqft, 6);
  });

  it('keeps the original when both ends would be too short to fix', () => {
    // A room narrower than the minimum end cut cannot satisfy it; the engine must terminate.
    const layout = computePlankLayout(
      inputs({
        walls: rectWalls(0.4, 6),
        layout: { ...defaults.layout, minEndCutIn: 24, expansionGapIn: 0 },
      })
    );
    expect(layout.planks.length).toBeGreaterThan(0);
  });
});

describe('the cut list and the waste figure', () => {
  it('counts every cut piece and nothing else', () => {
    const layout = layoutOf({});
    const listed = layout.cutList.reduce((sum, entry) => sum + entry.count, 0);
    expect(listed).toBe(layout.cutPieces);
    expect(layout.cutPieces + layout.fullPieces).toBe(layout.planks.length);
  });

  /**
   * `Plank.cut`, the two counts and the list are one question asked three times.
   *
   * They used to answer it differently: the rip was in the flag and out of the counts, so a
   * board ripped at stock length was counted as a whole board, listed nowhere, and still said
   * "cut" when it was clicked.
   */
  it('is one definition of a cut board, not three', () => {
    for (const config of [{}, { runAngleDeg: 30 }, { expansionGapIn: 0 }]) {
      const layout = layoutOf(config);
      const flagged = layout.planks.filter((p) => p.cut).length;
      expect(flagged, JSON.stringify(config)).toBe(layout.cutPieces);
      expect(layout.cutPieces + layout.fullPieces).toBe(layout.planks.length);
    }
  });

  /**
   * A rip is a saw setting, so it is on the line rather than folded into the length.
   *
   * A 20 x 20 room on a 7" plank leaves a last row of 1 1/2", and some of its boards are the same
   * length as full-width ones elsewhere on the floor. Grouped by length alone those merged, and
   * the list sent the installer to cut six boards at one width when one of them was a rip.
   */
  it('carries the rip width, and does not hide a rip in the full-width line', () => {
    const layout = layoutOf({});
    const ripped = layout.cutList.filter((e) => e.ripWidthIn != null);
    expect(ripped.length).toBeGreaterThan(0);

    for (const entry of ripped) {
      expect(entry.ripWidthIn!).toBeLessThan(defaults.plank.widthIn);
      expect(entry.ripWidthIn!).toBeGreaterThan(0);
      // A line at the same length but full width has to still be its own line.
      const full = layout.cutList.find(
        (e) => e.lengthIn === entry.lengthIn && e.ripWidthIn == null
      );
      if (full) expect(full.key).not.toBe(entry.key);
    }

    // Every ripped board on the floor is on a line that says so.
    const rippedBoards = layout.planks.filter(
      (p) => p.width < defaults.plank.widthIn / INCHES_PER_FOOT - 1e-6
    ).length;
    expect(ripped.reduce((sum, e) => sum + e.count, 0)).toBe(rippedBoards);
  });

  it('gives each line a key that identifies it, since the panel renders on it', () => {
    for (const config of [{}, { runAngleDeg: 30 }, { runAngleDeg: 7, expansionGapIn: 0 }]) {
      const layout = layoutOf(config);
      const keys = layout.cutList.map((e) => e.key);
      expect(new Set(keys).size, JSON.stringify(config)).toBe(keys.length);
    }
  });

  it('reports lengths to the nearest eighth of an inch, descending', () => {
    const layout = layoutOf({});
    for (const entry of layout.cutList) {
      expect(Math.round(entry.lengthIn * 8)).toBeCloseTo(entry.lengthIn * 8, 9);
    }
    const lengths = layout.cutList.map((e) => e.lengthIn);
    expect([...lengths].sort((a, b) => b - a)).toEqual(lengths);
  });

  it('buys fewer boards than there are pieces, because off-cuts start the next run', () => {
    const layout = layoutOf({});
    expect(layout.purchasedPlanks).toBeLessThan(layout.planks.length);
    expect(layout.purchasedPlanks).toBeGreaterThanOrEqual(layout.fullPieces);
  });

  it('lets the piece past an obstacle start a run, so it can come from an off-cut', () => {
    /**
     * An island splits every row it crosses into two spans, and the first piece of the *second*
     * span begins a fresh run of boards — the one place an off-cut can actually be used.
     *
     * The run-start has to be decided per span, not per band: a band's spans are separated by
     * floor that is not there, so they are different runs. Scoping it per band instead makes
     * every far-side piece buy a whole board. Measured on this fixture: 146 boards bought and
     * 11.9% waste with the reuse, 163 and 21.1% without.
     */
    const island: Obstacle = makeObstacle('island', { x: 5, y: 2 }, 10);
    const layout = layoutOf(
      { expansionGapIn: 0, stagger: 'none', minEndCutIn: 0 },
      { obstacles: [island] }
    );
    expect(layout.planks.length).toBeGreaterThan(150);
    expect(layout.purchasedPlanks).toBeLessThan(layout.planks.length - 10);
  });

  it('waste is what was bought and not installed', () => {
    const layout = layoutOf({});
    expect(layout.purchasedSqft).toBeGreaterThanOrEqual(layout.coveredSqft);
    expect(layout.wastePercent).toBeCloseTo(
      ((layout.purchasedSqft - layout.coveredSqft) / layout.purchasedSqft) * 100,
      9
    );
    expect(layout.wastePercent).toBeGreaterThanOrEqual(0);
  });

  it('gives a square cut a length and nothing else', () => {
    // Rectilinear room, run square to it: every end cut is a straight one, and a short point
    // and an angle on a straight cut are noise on the page.
    const layout = layoutOf({});
    for (const entry of layout.cutList) {
      expect(entry.shortIn).toBeUndefined();
      expect(entry.angleDeg).toBeUndefined();
    }
  });

  it('gives a mitred cut a long point, a short point and an angle', () => {
    // A run at 30°, where every wall is diagonal in the run frame. An installer setting a saw
    // needs all three; a length alone would send them to cut a square end.
    const layout = layoutOf({ runAngleDeg: 30, expansionGapIn: 0 });
    const mitred = layout.cutList.filter((e) => e.shortIn != null);
    expect(mitred.length).toBeGreaterThan(0);
    for (const entry of mitred) {
      expect(entry.shortIn!).toBeLessThan(entry.lengthIn);
      expect(entry.angleDeg!).toBeGreaterThan(0);
      // Rounded as the panel prints them: eighths of an inch, whole degrees.
      expect(Math.round(entry.shortIn! * 8)).toBeCloseTo(entry.shortIn! * 8, 9);
      expect(Math.round(entry.angleDeg!)).toBe(entry.angleDeg!);
    }
    // Still one line per distinct piece, and still every cut piece accounted for.
    expect(layout.cutList.reduce((sum, e) => sum + e.count, 0)).toBe(layout.cutPieces);
  });

  it('an awkward room wastes more than a room that tiles', () => {
    const tiles = layoutOf({ stagger: 'none', expansionGapIn: 0 });
    const awkward = computePlankLayout(
      inputs({
        walls: rectWalls(17.3, 13.7),
        layout: { ...defaults.layout, stagger: 'none', expansionGapIn: 0 },
      })
    );
    expect(awkward.wastePercent).toBeGreaterThan(tiles.wastePercent);
  });
});

/**
 * `stagger: 'offcut'` — start each row with what the row below left over.
 *
 * The rule an installer works to, and the only stagger here that is a function of the row *below*
 * rather than of the row's index. One pass of the saw makes two pieces: the end of a row and the
 * board that starts the next. Every other rule puts the grid at a fraction of a plank, so the
 * first piece is short as well as the last and the leftover goes on the pile.
 */
describe('staggering off the off-cut', () => {
  /** Where each board begins along the run. At `runAngleDeg: 0` that is just its left edge. */
  const jointsByRow = (layout: ReturnType<typeof layoutOf>): Map<number, number[]> => {
    const rows = new Map<number, number[]>();
    for (const plank of layout.planks) {
      const starts = rows.get(plank.row) ?? [];
      starts.push(plank.center.x - plank.length / 2);
      rows.set(plank.row, starts);
    }
    for (const starts of rows.values()) starts.sort((a, b) => a - b);
    return rows;
  };

  /**
   * A room that does *not* divide evenly by the plank, which is the only kind where an off-cut
   * is worth anything: 17.3 ft on a 48" board leaves a third of a board over at the end of every
   * row, which is exactly what the next row wants.
   */
  const awkward = (stagger: StaggerRule) =>
    computePlankLayout(
      inputs({
        walls: rectWalls(17.3, 13.7),
        layout: { ...defaults.layout, stagger },
      })
    );

  it('makes fewer cuts than a fractional stagger, for the same waste', () => {
    const offcut = awkward('offcut');
    const thirds = awkward('thirds');
    const half = awkward('half');

    expect(offcut.sawCuts).toBeLessThan(thirds.sawCuts);
    expect(offcut.sawCuts).toBeLessThan(half.sawCuts);
    // Measured on this room: 27 cuts against 39 and 36 — near a third fewer.
    expect(offcut.sawCuts / thirds.sawCuts).toBeLessThan(0.8);
    // And it does not buy the saving with material. Off-cuts consumed where they fall are the
    // same off-cuts the purchase model was already re-using; what changes is the cutting.
    expect(offcut.wastePercent).toBeLessThanOrEqual(thirds.wastePercent + 1e-9);
    expect(offcut.purchasedPlanks).toBeLessThanOrEqual(thirds.purchasedPlanks);
    // The floor itself is unchanged — this is a rule about where joints fall, not about area.
    expect(offcut.coveredSqft).toBeCloseTo(thirds.coveredSqft, 6);
  });

  it('never lands two touching rows on the same joint', () => {
    // The ladder: two rows joining in the same place, which is the one thing the off-cut is not
    // allowed to buy. A room that divides evenly is the case that produces it — every row ends
    // flush, nothing is left over, and taken at face value every row would start flush too.
    for (const [w, h] of [
      [17.3, 13.7],
      [20, 20],
      [16, 12],
      [12, 10.4],
    ] as const) {
      const layout = computePlankLayout(
        inputs({ walls: rectWalls(w, h), layout: { ...defaults.layout, stagger: 'offcut' } })
      );
      const rows = jointsByRow(layout);
      const indices = [...rows.keys()].sort((a, b) => a - b);
      for (let i = 0; i + 1 < indices.length; i++) {
        if (indices[i + 1] !== indices[i] + 1) continue;
        const below = rows.get(indices[i])!;
        const above = rows.get(indices[i + 1])!;
        for (const joint of above.slice(1)) {
          for (const other of below.slice(1)) {
            const apart = Math.abs(joint - other) * INCHES_PER_FOOT;
            expect(
              apart,
              `${w}x${h} rows ${indices[i]}/${indices[i + 1]} at ${joint.toFixed(3)}`
            ).toBeGreaterThan(MIN_JOINT_OFFSET_IN - 1e-6);
          }
        }
      }
    }
  });

  it('falls back to half a board where the room leaves nothing worth using', () => {
    // 20 ft on a 48" board is five planks to the inch: the leftover is half an inch, which is
    // not a board. The rule has to still lay a legal floor, and the honest one to fall back on
    // is the largest separation there is.
    const evenly = computePlankLayout(
      inputs({ walls: rectWalls(20, 20), layout: { ...defaults.layout, stagger: 'offcut' } })
    );
    const half = computePlankLayout(
      inputs({ walls: rectWalls(20, 20), layout: { ...defaults.layout, stagger: 'half' } })
    );
    expect(evenly.sawCuts).toBe(half.sawCuts);
    expect(evenly.planks).toHaveLength(half.planks.length);
  });

  it('is a pure function of the inputs, like every other rule', () => {
    const once = awkward('offcut');
    const twice = awkward('offcut');
    expect(once.key).toBe(twice.key);
    expect(once.planks.map((p) => p.id)).toEqual(twice.planks.map((p) => p.id));
    expect(once.sawCuts).toBe(twice.sawCuts);
    // And it keys apart from the rules it is not.
    expect(once.key).not.toBe(awkward('half').key);
  });
});

/**
 * A cut is a pass of the saw, not a piece that is not a full board. One pass makes two pieces.
 */
describe('cuts to make against pieces that are not full boards', () => {
  it('is never more cuts than there are pieces to cut', () => {
    for (const stagger of ['none', 'half', 'thirds', 'random', 'offcut'] as const) {
      const layout = layoutOf({ stagger });
      expect(layout.sawCuts, stagger).toBeLessThanOrEqual(layout.cutPieces);
      expect(layout.sawCuts, stagger).toBeGreaterThan(0);
    }
  });

  it('charges nothing for a piece that came off an off-cut whole', () => {
    // Every full board is free, and every piece that is not full costs at most one pass — so the
    // saving over `cutPieces` is exactly the pieces that were already cut when they arrived.
    const layout = layoutOf({ stagger: 'offcut' }, { walls: rectWalls(17.3, 13.7) });
    expect(layout.cutPieces - layout.sawCuts).toBeGreaterThan(0);
  });
});

describe('the run frame', () => {
  it('every plank shares the run angle', () => {
    const layout = layoutOf({ runAngleDeg: 45 });
    expect(layout.angle).toBeCloseTo(Math.PI / 4, 9);
  });

  it('a diagonal run still covers the room', () => {
    const straight = layoutOf({ runAngleDeg: 0, expansionGapIn: 0 });
    const diagonal = layoutOf({ runAngleDeg: 45, expansionGapIn: 0 });
    expect(diagonal.coveredSqft).toBeCloseTo(straight.coveredSqft, 0);
    // A diagonal run cuts more pieces against the walls — that is the point of the choice.
    expect(diagonal.cutPieces).toBeGreaterThan(straight.cutPieces);
  });

  it('each start corner produces a different floor and the same coverage', () => {
    const corners = ['bottomLeft', 'bottomRight', 'topLeft', 'topRight'] as const;
    const layouts = corners.map((startCorner) =>
      layoutOf({ startCorner, expansionGapIn: 0, stagger: 'thirds' })
    );
    for (const layout of layouts) {
      expect(layout.coveredSqft).toBeCloseTo(400, 1);
    }
    const signatures = layouts.map((l) => l.planks.map((p) => p.length.toFixed(4)).join(','));
    expect(new Set(signatures).size).toBeGreaterThan(1);
  });

  it('moving the origin moves the joints, which is why it is draggable', () => {
    const at0 = layoutOf({ stagger: 'none', expansionGapIn: 0 });
    const at1 = layoutOf({ stagger: 'none', expansionGapIn: 0 }, { origin: { x: 1.5, y: 0 } });
    expect(at1.planks.map((p) => p.length)).not.toEqual(at0.planks.map((p) => p.length));
  });
});

describe('layoutKey — the cache key', () => {
  it('is stable for value-equal inputs reached by different routes', () => {
    const a = inputs();
    const b = inputs({ walls: rectWalls(20, 20), obstacles: [] });
    expect(layoutKey(a)).toBe(layoutKey(b));
  });

  it('changes for every input the layout depends on', () => {
    const base = layoutKey(inputs());
    expect(layoutKey(inputs({ walls: rectWalls(21, 20) }))).not.toBe(base);
    expect(layoutKey(inputs({ obstacles: [makeObstacle('o', { x: 2, y: 2 }, 3)] }))).not.toBe(base);
    expect(layoutKey(inputs({ origin: { x: 1, y: 0 } }))).not.toBe(base);
    expect(
      layoutKey(inputs({ plank: { ...defaults.plank, widthIn: defaults.plank.widthIn + 1 } }))
    ).not.toBe(base);
    expect(layoutKey(inputs({ layout: { ...defaults.layout, stagger: 'half' } }))).not.toBe(base);
    expect(layoutKey(inputs({ layout: { ...defaults.layout, seed: 99 } }))).not.toBe(base);
  });

  it('is the key the layout reports, so a cache cannot serve the wrong floor', () => {
    const value = inputs({ origin: { x: 3, y: 4 } });
    expect(computePlankLayout(value).key).toBe(layoutKey(value));
  });
});

describe('bounded work', () => {
  it('a degenerate plank truncates instead of hanging the tab', () => {
    const plank: PlankSpec = { widthIn: 0.005, lengthIn: 0.005, name: 'absurd', minRipWidthIn: 0 };
    const layout = computePlankLayout(inputs({ plank }));
    expect(layout.truncated).toBe(true);
    expect(layout.planks.length).toBeLessThanOrEqual(20000);
  });

  it('an aborted signal stops the run rather than finishing it', () => {
    const controller = new AbortController();
    controller.abort();
    const layout = computePlankLayout(inputs(), controller.signal);
    expect(layout.planks).toHaveLength(0);
    expect(layout.truncated).toBe(true);
  });
});

describe('laying over part of the room', () => {
  /** The bottom 8ft of the 20x20 room, as `RegionSolver` would hand it over. */
  const bottom: Vector2[] = [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 8 },
    { x: 0, y: 8 },
  ];
  const top: Vector2[] = [
    { x: 0, y: 8 },
    { x: 20, y: 8 },
    { x: 20, y: 20 },
    { x: 0, y: 20 },
  ];

  const noGap = { ...defaults.layout, expansionGapIn: 0 };

  it('lays the whole room when regions is null', () => {
    const whole = computePlankLayout(inputs({ layout: noGap }));
    const explicitlyNull = computePlankLayout(inputs({ layout: noGap, regions: null }));
    expect(explicitlyNull.planks).toHaveLength(whole.planks.length);
    expect(explicitlyNull.coveredSqft).toBeCloseTo(whole.coveredSqft, 6);
  });

  it('covers only the region it is given', () => {
    const clipped = computePlankLayout(inputs({ layout: noGap, regions: [bottom] }));
    expect(clipped.planks.length).toBeGreaterThan(0);
    for (const plank of clipped.planks) expect(plank.center.y).toBeLessThanOrEqual(8);

    // Exactly 160 sq ft: a region's edges break the row grid, so the band against y = 8 is
    // ripped at it rather than laid across it. No part of the single-scanline approximation
    // applies to an area edge that runs along the rows.
    expect(clipped.coveredSqft).toBeCloseTo(160, 4);
  });

  it('lays nothing at all for an empty region list — which is not the same as null', () => {
    // Every area assigned to carpet or tile. `null` would have meant the whole room.
    const none = computePlankLayout(inputs({ layout: noGap, regions: [] }));
    expect(none.planks).toHaveLength(0);
    expect(none.coveredSqft).toBe(0);
    expect(
      computePlankLayout(inputs({ layout: noGap, regions: null })).planks.length
    ).toBeGreaterThan(0);
  });

  it('two regions covering the room together cover what the whole room did', () => {
    const whole = computePlankLayout(inputs({ layout: noGap }));
    const split = computePlankLayout(inputs({ layout: noGap, regions: [bottom, top] }));
    expect(split.coveredSqft).toBeCloseTo(whole.coveredSqft, 4);
  });

  it('keeps the joint grid anchored to the origin, not to the region', () => {
    // The point of indexing bands against the room's row grid: the rows either side of a
    // transition line up rather than each restarting its stagger at its own edge. Compared by
    // geometry rather than by id, because a region edge splits one row into two bands and the
    // ids are per band.
    const joints = (layout: ReturnType<typeof computePlankLayout>): Set<string> =>
      new Set(layout.planks.map((p) => `${(p.center.x - p.length / 2).toFixed(6)}`));

    const whole = computePlankLayout(inputs({ layout: noGap }));
    for (const region of [top, bottom]) {
      const clipped = computePlankLayout(inputs({ layout: noGap, regions: [region] }));
      // Every joint in the clipped floor falls on a joint of the unclipped one: the run was
      // shortened, never re-anchored.
      for (const joint of joints(clipped)) expect(joints(whole)).toContain(joint);
    }
  });

  it('rips the row at a region edge instead of laying it across', () => {
    // The bug this guards: the band was clipped to the room but not to the region, so a row
    // straddling the transition was laid whole. Which rows straddled depended on the row grid,
    // and the grid is anchored at the origin — so dragging the origin marker swung the floor's
    // edge either side of the transition and the expansion gap came and went with it.
    const gapFt = defaults.layout.expansionGapIn / 12;
    for (let i = 0; i < 12; i++) {
      const layout = computePlankLayout(
        inputs({ origin: { x: 0, y: Math.round(i * 0.13 * 1000) / 1000 }, regions: [bottom] })
      );
      const highest = Math.max(...layout.planks.map((p) => p.center.y + p.width / 2));
      // The region tops out at y = 8; the floor stops one expansion gap short of it, whatever
      // the origin. Before the fix this ranged over 7.71 … 8.23.
      //
      // Short of it by up to a quarter inch, because where the grid leaves a strip narrower than
      // that against the edge there is no board to lay — see `MIN_BOARD_FT`. That is a strip the
      // trim covers; the half-foot swing this test exists to catch is not.
      expect(highest).toBeLessThanOrEqual(8 - gapFt + 1e-9);
      expect(highest).toBeGreaterThan(8 - gapFt - 0.25 / 12);
    }
  });

  it('counts the area of a clipped region exactly, now that the edge rows are ripped', () => {
    const clipped = computePlankLayout(inputs({ layout: noGap, regions: [bottom] }));
    expect(clipped.coveredSqft).toBeCloseTo(160, 4);
  });

  it('takes the expansion gap at a region edge too', () => {
    // A transition strip is an expansion joint: a floating floor has to be able to move at one.
    const gapped = computePlankLayout(inputs({ regions: [bottom] }));
    const tight = computePlankLayout(inputs({ layout: noGap, regions: [bottom] }));
    expect(gapped.coveredSqft).toBeLessThan(tight.coveredSqft);
    for (const plank of gapped.planks) expect(plank.center.y).toBeLessThan(8);
  });

  it('keys differently for different regions, and identically for the same ones', () => {
    const a = layoutKey(inputs({ regions: [bottom] }));
    expect(layoutKey(inputs({ regions: [bottom] }))).toBe(a);
    expect(layoutKey(inputs({ regions: [top] }))).not.toBe(a);
    expect(layoutKey(inputs({ regions: null }))).not.toBe(a);
    expect(layoutKey(inputs({ regions: [] }))).not.toBe(a);
  });
});

describe('a wall that runs along the rows', () => {
  /**
   * The room from the report, simplified: a rectangle with a notch dropping out of its bottom
   * edge, so the wall at x = -1 runs **along** the rows once the run is turned to 90°.
   *
   * This block used to assert the opposite of what it asserts now, and the reversal is the
   * point of the boundary-cut work. The old reading was that a row boundary on the notch wall
   * is a plank split down its length at an inside corner for no visible reason, so a wall that
   * ran along the rows was filtered out of the band edges. But at run 90° the boards run along
   * world y, and the notch wall is where the room stops being there: a board straddling x = -1
   * runs from y = −11 to y = 6 over its left half and hangs over nothing under its right. The
   * rip is not an artefact, it is the cut an installer makes — and the band split that produces
   * it is also what keeps every span's endpoint linear across a band, which is what makes the
   * diagonal-wall cut exact.
   */
  const notched: Vector2[] = [
    { x: -6, y: 6 },
    { x: 6, y: 6 },
    { x: 6, y: -6 },
    { x: -1, y: -6 },
    { x: -1, y: -11 },
    { x: -6, y: -11 },
  ];
  const walls = wallsOf(notched);
  // A diagonal divider cutting off the notch, so the region clip is live.
  const region: Vector2[] = [
    { x: -6, y: 6 },
    { x: 6, y: 6 },
    { x: 6, y: -6 },
    { x: -1, y: -6 },
    { x: -6, y: -8 },
  ];

  const layoutAt = (widthIn: number, origin: Vector2) =>
    computePlankLayout(
      inputs({
        walls,
        origin,
        plank: { ...defaults.plank, widthIn },
        layout: { ...defaults.layout, runAngleDeg: 90 },
        regions: [region],
      })
    );

  /** Run 90°: rows stack along world x, so a row boundary is a world-x value. */
  const rowEdges = (widthIn: number, origin: Vector2): number[] =>
    [
      ...new Set(
        layoutAt(widthIn, origin).planks.map((p) => Number((p.center.x - p.width / 2).toFixed(9)))
      ),
    ]
      .sort((a, b) => a - b)
      .filter((v) => v > -5.9 && v < 5.9);

  it('rips the row at it rather than hanging a board over the missing quadrant', () => {
    for (const origin of [
      { x: 0, y: 0 },
      { x: 0.68, y: 0.97 },
      { x: 2.5, y: -1.5 },
    ]) {
      const layout = layoutAt(15.5, origin);
      expect(layout.planks.length).toBeGreaterThan(0);
      // Nothing outside the room, at any origin. Before the split, the band straddling x = −1
      // was laid at the width its centreline happened to fall on: either across the notch wall
      // and out over bare ground, or not at all.
      for (const plank of layout.planks) {
        for (const corner of plank.corners) {
          expect(clearance(notched, corner)).toBeGreaterThan(-1e-6);
        }
      }
    }
  });

  it('puts every other row boundary on the grid the origin anchors', () => {
    // The bug that first found this block: a row boundary immune to both the plank width and the
    // layout origin. Boundaries still come from the grid and from the outline, and nowhere else,
    // so the only ones off the grid are at heights the room or the region actually turns.
    const turns = new Set([...notched, ...region].map((p) => Number(p.x.toFixed(6))));
    for (const widthIn of [7, 15.5]) {
      for (const origin of [
        { x: 0, y: 0 },
        { x: 0.68, y: 0.97 },
        { x: 2.5, y: -1.5 },
      ]) {
        const edges = rowEdges(widthIn, origin);
        expect(edges.length).toBeGreaterThan(3);
        const step = widthIn / 12;
        // Every origin here is inside the room, where there is no wall to measure a gap from, so
        // the grid runs through the origin itself — see `anchorOf` in the engine.
        const anchor = origin.x;
        for (const edge of edges) {
          const offGrid = Math.abs(edge - anchor - Math.round((edge - anchor) / step) * step);
          if (offGrid < 1e-6) continue;
          // Not on the grid: it must be a corner of the outline, give or take the gap the inset
          // moved that corner by.
          const nearestTurn = Math.min(...[...turns].map((t) => Math.abs(edge - t)));
          expect(nearestTurn).toBeLessThanOrEqual(defaults.layout.expansionGapIn / 12 + 1e-6);
        }
      }
    }
  });

  it('still moves the grid boundaries when the origin moves', () => {
    // The counterpart: a floor whose joints ignored the origin was the original symptom. The
    // boundaries that come from the outline stay put, which is the whole reason they exist.
    const fixed = new Set([...notched, ...region].map((p) => Number(p.x.toFixed(6))));
    const isOnOutline = (edge: number): boolean =>
      Math.min(...[...fixed].map((t) => Math.abs(edge - t))) <=
      defaults.layout.expansionGapIn / 12 + 1e-6;

    const a = rowEdges(15.5, { x: 0, y: 0 }).filter((e) => !isOnOutline(e));
    const b = rowEdges(15.5, { x: 0.4, y: 0 });
    expect(a.length).toBeGreaterThan(0);
    for (const edge of a) expect(b).not.toContain(edge);
  });
});

describe('the minimum rip width', () => {
  /** 20 ft of height is 34.28 rows of 7": the last row rips to exactly 2". */
  const withMinRip = (minRipWidthIn: number) =>
    computePlankLayout(
      inputs({
        plank: { ...defaults.plank, minRipWidthIn },
        layout: { ...defaults.layout, expansionGapIn: 0 },
      })
    );

  it('flags the boards ripped below it and no others', () => {
    const layout = withMinRip(2.25);
    const narrow = layout.planks.filter((p) => p.narrow);
    expect(narrow.length).toBeGreaterThan(0);
    expect(narrow.length).toBe(layout.narrowPieces);
    for (const plank of layout.planks) {
      expect(plank.narrow).toBe(plank.width * 12 < 2.25 - 1e-9);
    }
  });

  it('flags nothing when the rip clears the minimum', () => {
    const layout = withMinRip(1.5);
    expect(layout.narrowPieces).toBe(0);
    expect(layout.planks.some((p) => p.narrow)).toBe(false);
    // Still ripped — the check is advisory, so the geometry is the same floor either way.
    expect(layout.narrowestRipIn).toBeCloseTo(2, 4);
    expect(layout.planks.length).toBe(withMinRip(2.25).planks.length);
  });

  it('is off at zero', () => {
    expect(withMinRip(0).narrowPieces).toBe(0);
  });

  it('never flags a board that was not ripped, whatever the minimum', () => {
    // Clamped to the plank's own width: a minimum above it would otherwise light up the
    // full-width rows too, which is noise rather than a warning.
    const layout = withMinRip(defaults.plank.widthIn * 2);
    expect(layout.narrowPieces).toBeGreaterThan(0);
    for (const plank of layout.planks) {
      if (plank.narrow) expect(plank.width).toBeLessThan(defaults.plank.widthIn / 12 - 1e-9);
    }
  });

  it('reports the narrowest rip, and nothing when the floor came out even', () => {
    expect(withMinRip(2.25).narrowestRipIn).toBeCloseTo(2, 4);
    // 21 ft of height is exactly 36 rows of 7", so no row is ripped at all.
    const even = computePlankLayout(
      inputs({ walls: rectWalls(20, 21), layout: { ...defaults.layout, expansionGapIn: 0 } })
    );
    expect(even.narrowestRipIn).toBeNull();
    expect(even.narrowPieces).toBe(0);
  });

  it('is part of the structural key, since it decides which boards are flagged', () => {
    expect(layoutKey(inputs({ plank: { ...defaults.plank, minRipWidthIn: 2 } }))).not.toBe(
      layoutKey(inputs({ plank: { ...defaults.plank, minRipWidthIn: 3 } }))
    );
  });
});

/**
 * The outlines reaching the engine have been through a region merge, a divider snap and a polygon
 * inset, and each leaves vertices off true by a fraction of an inch or less. Separated at `EPS`,
 * such a vertex became a band of its own — and a band becomes boards, one per joint along the
 * run: a row of zero-inch planks against a wall, cut, counted, priced and flagged as ripped below
 * the minimum, on a floor where there is visibly nothing there.
 *
 * The floor a wobbly outline lays must be the floor a clean one lays, board for board.
 */
describe('an outline that is off true by less than a saw kerf', () => {
  /** A 20 x 20 room with one extra vertex `offset` feet off the left wall's line. */
  const wobbly = (offset: number): WallSegment[] =>
    wallsOf([...ring(20, 20), { x: offset, y: 10 }]);

  const laid = (walls: WallSegment[]) =>
    computePlankLayout(inputs({ walls, layout: { ...defaults.layout, runAngleDeg: 90 } }));

  it('lays no board thinner than a saw can cut', () => {
    for (const offset of [1e-9, 1e-7, 1e-5, 1e-4]) {
      const layout = laid(wobbly(offset));
      const slivers = layout.planks.filter((p) => p.width * INCHES_PER_FOOT < 1 / 32);
      expect(slivers, `offset ${offset}`).toHaveLength(0);
      expect(layout.narrowestRipIn ?? Infinity, `offset ${offset}`).toBeGreaterThan(1 / 32);
    }
  });

  it('lays the same floor the clean room lays', () => {
    const clean = laid(wallsOf(ring(20, 20)));
    const wobble = laid(wobbly(1e-5));
    expect(wobble.planks).toHaveLength(clean.planks.length);
    expect(wobble.narrowPieces).toBe(clean.narrowPieces);
    expect(wobble.narrowestRipIn).toBeCloseTo(clean.narrowestRipIn as number, 6);
    expect(wobble.coveredSqft).toBeCloseTo(clean.coveredSqft, 4);
    expect(wobble.cutList).toHaveLength(clean.cutList.length);
  });

  /**
   * The case from a real document: a room traced by hand, so its left and right walls run 11 and
   * 13 ft while drifting 0.0162 ft — 0.194", a sixth of an inch, 0.08° off square. With the run
   * *parallel* to those walls, the band grid must break at each of their endpoints, and the band
   * between them is a row 0.194" tall spanning the wall's whole length. That was eight boards
   * against two walls plus a crumb in a corner: nine pieces, cut, counted, priced and flagged as
   * ripped below the minimum, on a floor showing nothing there at all.
   */
  describe('a wall a fraction of a degree out of square, with the run parallel to it', () => {
    const drift = 0.0162;
    const traced = wallsOf([
      { x: 0, y: 0 },
      { x: 20 + drift, y: 0 },
      { x: 20, y: 20 },
      { x: drift, y: 20 },
    ]);
    const layout = computePlankLayout(
      inputs({ walls: traced, layout: { ...defaults.layout, runAngleDeg: 90 } })
    );

    it('lays no board too narrow to install', () => {
      for (const plank of layout.planks) {
        expect(plank.width * INCHES_PER_FOOT).toBeGreaterThanOrEqual(0.25);
        expect(plank.length * INCHES_PER_FOOT).toBeGreaterThanOrEqual(0.25);
      }
    });

    it('warns about the rip that is real and not about the wall being crooked', () => {
      // The square room's own last row is 1.5" and is genuinely below the minimum — that warning
      // is the feature. What must not be added to it is the wedge along the crooked wall.
      const square = computePlankLayout(
        inputs({ walls: wallsOf(ring(20, 20)), layout: { ...defaults.layout, runAngleDeg: 90 } })
      );
      expect(layout.narrowPieces).toBe(square.narrowPieces);
      // Wider than the square room's by at most the drift itself: the wedge against the crooked
      // wall is a bend in that row's boundary, not a row of its own, so the last board takes it
      // in and reaches the wall rather than stopping square and leaving it bare.
      const extra = (layout.narrowestRipIn as number) - (square.narrowestRipIn as number);
      expect(extra).toBeGreaterThanOrEqual(0);
      expect(extra).toBeLessThanOrEqual(drift * INCHES_PER_FOOT + 1e-6);
    });

    it('still covers the room, since what it drops is a strip under the trim', () => {
      // The wedges left bare are 0.194" x 20 ft twice — under a hundredth of the floor.
      expect(layout.coveredSqft).toBeGreaterThan(0.99 * 20 * 20 - 20);
    });

    /**
     * A taper a fifth of an inch tall at one corner of a board is a **scribe**, not a mitre.
     *
     * The board is cut square and shaved to the wall on site; the saw is set from the rest of
     * its width. Read as a cut, the same taper reported a mitre of nearly 90° down to a short
     * point of zero — `48" → 0" @ 90°`, a line for a board that was never cut that way, in a
     * room whose walls are a fifteenth of a degree off square. Which is every traced room.
     */
    it('does not report the crooked wall as a mitre no saw can be set to', () => {
      for (const entry of layout.cutList) {
        if (entry.angleDeg == null) continue;
        expect(entry.angleDeg, JSON.stringify(entry)).toBeLessThan(60);
        expect(entry.shortIn, JSON.stringify(entry)).toBeGreaterThan(0);
      }
    });
  });

  it('still resolves a step it could actually cut to', () => {
    // A quarter inch is a feature, not noise: the rip against it is a real board.
    const stepped = laid(wobbly(0.25 / INCHES_PER_FOOT));
    expect(stepped.planks.length).toBeGreaterThan(laid(wallsOf(ring(20, 20))).planks.length);
  });
});

/**
 * A board's outline is a board's outline: every corner of it belongs to that board.
 *
 * The band model gives a span two ends and lays every piece of it from the band's floor to its
 * ceiling. Where the span **closes to a point** inside the band — which is what a boundary
 * running nearly along the rows does, and every hand-traced wall is a fraction of a degree off
 * square — every piece used to take that point as an end, wherever in the room it was. Boards
 * came out with corners feet away from themselves: outlines doubling back through themselves,
 * `coveredSqft` counted off triangles that are not there, `PlankIndex` answering with a board
 * nowhere near the cursor, and a cut list carrying `48" → 0" @ 90°`.
 *
 * The measure is deliberately crude and deliberately independent of how the outline is built: a
 * board of `length` x `width` about its centre cannot have a corner further from that centre
 * than its own half-diagonal, whatever it was cut to and however many corners it has.
 */
describe('every corner of a board belongs to that board', () => {
  const reach = (plank: { length: number; width: number }) =>
    Math.hypot(plank.length, plank.width) / 2 + 1e-6;

  const noStrays = (layout: ReturnType<typeof layoutOf>, what: string) => {
    expect(layout.planks.length, `${what} lays a floor at all`).toBeGreaterThan(0);
    for (const plank of layout.planks) {
      for (const corner of plank.corners) {
        const away = Math.hypot(corner.x - plank.center.x, corner.y - plank.center.y);
        expect(
          away,
          `${what}: ${plank.id} reaches ${((away - reach(plank)) * 12).toFixed(1)}" out`
        ).toBeLessThanOrEqual(reach(plank));
      }
    }
  };

  /** 0.0162 ft over 20 ft — 0.194", a sixth of an inch, 0.05° off square. A traced room. */
  const drift = 0.0162;
  const traced = wallsOf([
    { x: 0, y: 0 },
    { x: 20 + drift, y: 0 },
    { x: 20, y: 20 },
    { x: drift, y: 20 },
  ]);

  it('with the run across a wall that is a fraction of a degree out of square', () => {
    for (const runAngleDeg of [0, 90, 180, 270]) {
      noStrays(layoutOf({ runAngleDeg }, { walls: traced }), `traced room at ${runAngleDeg}°`);
    }
  });

  it('at every run angle, on a room that does not divide evenly by the plank', () => {
    for (const runAngleDeg of [0, 7, 20, 33, 45, 61, 90, 127, 180]) {
      noStrays(layoutOf({ runAngleDeg }, { walls: rectWalls(12, 10.4) }), `run ${runAngleDeg}°`);
    }
  });

  it('on a concave room, where the boundary steps in the middle of a row', () => {
    const ell = wallsOf([
      { x: 0, y: 0 },
      { x: 14, y: 0 },
      { x: 14, y: 8 },
      { x: 7, y: 8 },
      { x: 7, y: 13 },
      { x: 0, y: 13 },
    ]);
    for (const runAngleDeg of [0, 45, 90]) {
      noStrays(layoutOf({ runAngleDeg }, { walls: ell }), `L room at ${runAngleDeg}°`);
    }
  });
});

/**
 * A boundary that **bends** across a board is not a boundary that **steps** across it.
 *
 * A diagonal transition running into a wall takes a corner off an otherwise whole board: one
 * piece of stock, two cuts on one end. Treating that as two boards ripped it lengthwise into two
 * full-length strips — a rip no installer would make, a seam down the middle of a whole board,
 * two boards bought for one and two lines in the cut list for one corner.
 *
 * The room is 20 x 20 and the plank region is all of it but a triangle notched into the left
 * wall: out along the wall to y = 4, in to the apex at (3, 7), back to the wall at y = 10. The
 * notch's two ends are the two cases — a corner clipped where the diagonal meets the wall, and
 * an apex where two diagonals meet each other.
 */
describe('a boundary that bends across a board', () => {
  const notched: Vector2[] = [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 20 },
    { x: 0, y: 20 },
    { x: 0, y: 10 },
    { x: 3, y: 7 },
    { x: 0, y: 4 },
  ];
  const noGap = { ...defaults.layout, expansionGapIn: 0 };
  const layout = computePlankLayout(inputs({ layout: noGap, regions: [notched] }));

  /** Boards whose ends do not lie on one straight cut each. */
  const bent = layout.planks.filter((p) => p.corners.length > 4);

  it('takes the corner off one board instead of ripping it into two strips', () => {
    expect(bent.length).toBeGreaterThan(0);
    for (const plank of bent) {
      // The whole point: a bent end is a board of full nominal width, not two ripped strips.
      expect(plank.width * INCHES_PER_FOOT).toBeCloseTo(defaults.plank.widthIn, 6);
    }
  });

  it('leaves no two full-length strips stacked in one row', () => {
    // The signature of the bug: two boards of the same row, same run extent, stacked across the
    // width — which is one board someone sawed down the middle.
    for (const a of layout.planks) {
      for (const b of layout.planks) {
        if (a.id === b.id || a.row !== b.row) continue;
        const sameRun =
          Math.abs(a.center.x - b.center.x) < 1e-9 && Math.abs(a.length - b.length) < 1e-9;
        expect(sameRun && Math.abs(a.width + b.width - defaults.plank.widthIn / 12) < 1e-6).toBe(
          false
        );
      }
    }
  });

  it('keeps the ordinary board at four corners', () => {
    // `collapseStraight`'s job: the row grid and the room's own corners split bands everywhere,
    // and a board that does not bend must not collect a vertex from a split it never noticed.
    const plain = layout.planks.filter((p) => p.center.x > 6);
    expect(plain.length).toBeGreaterThan(10);
    for (const plank of plain) expect(plank.corners).toHaveLength(4);
  });

  it('covers the region exactly, bends and all', () => {
    // 400 sq ft less the notch, which is 3 wide at its apex over 6 of wall: 9 sq ft.
    expect(layout.coveredSqft).toBeCloseTo(400 - 9, 4);
  });

  it('buys one board for one board', () => {
    const strips = computePlankLayout(inputs({ layout: noGap, regions: [notched] }));
    // Every piece is at most a full plank of stock, and the bent ones are not double-counted:
    // the purchase model sees the board once, so it cannot exceed one plank per piece.
    expect(strips.purchasedPlanks).toBeLessThanOrEqual(strips.planks.length);
  });

  it('hands the renderer a profile that pairs points across the same band edge', () => {
    // What `plankProfile` promises, and what the renderer's per-segment quads depend on: entry
    // `i` is the board's two ends at one height, so consecutive entries bound one quad.
    const cos = Math.cos(layout.angle);
    const sin = Math.sin(layout.angle);
    const across = (p: Vector2): number => -p.x * sin + p.y * cos;
    for (const plank of layout.planks) {
      const profile = plankProfile(plank);
      expect(profile).toHaveLength(plank.corners.length / 2);
      for (const [start, end] of profile) expect(across(start)).toBeCloseTo(across(end), 9);
    }
  });

  it('finds every board under its own outline, concave ones included', () => {
    // The apex notches a V into a board, which is concave — the half-plane test this index used
    // to run answers "outside" for points genuinely inside such a board.
    const index = new PlankIndex(layout);
    for (const plank of bent) {
      const inside = interiorPoint(plank.corners);
      expect(inside, `${plank.id} has an interior`).not.toBeNull();
      expect(index.at(inside as Vector2)?.id, `${plank.id} from inside itself`).toBe(plank.id);
    }
  });
});

/**
 * A traced room with a transition landing on one of its corners.
 *
 * From a real document, and it is the shape that found three separate defects, so it is kept as
 * the geometry rather than as a tidied-up stand-in. Two things about it matter and neither
 * survives simplification: the left and right walls run 11 and 13 ft while drifting 0.0162 ft, so
 * they are a fraction of a degree off square; and the divider lands exactly on the room's corner
 * at (-0.2994, -7.7153), where the room turns 90° and the plank area turns 152°. Inset by the
 * expansion gap those two corners mitre to *different* heights a third of an inch apart, which
 * puts two band edges inside one row — and that is the row every one of the defects was in.
 */
describe('a transition landing on a room corner', () => {
  const traced: Vector2[] = [
    { x: -5.3207, y: 5.9676 },
    { x: 5.6844, y: 5.9676 },
    { x: 5.7006, y: -7.7153 },
    { x: -0.2994, y: -7.7153 },
    { x: -0.2994, y: -12.5766 },
    { x: -9.2737, y: -7.2167 },
    { x: -5.3045, y: -5.0948 },
  ];
  /** The plank area: everything above the chord from the left wall to the room's corner. */
  const plankArea: Vector2[] = [
    { x: -0.2994, y: -7.7153 },
    { x: 5.7006, y: -7.7153 },
    { x: 5.6844, y: 5.9676 },
    { x: -5.3207, y: 5.9676 },
    { x: -5.3045, y: -5.0948 },
  ];
  const GAP_IN = 0.25;
  const gapFt = GAP_IN / INCHES_PER_FOOT;
  const layout = computePlankLayout(
    inputs({
      walls: wallsOf(traced),
      layout: { ...defaults.layout, runAngleDeg: 90, expansionGapIn: GAP_IN },
      origin: { x: -0.09, y: 0 },
      regions: [plankArea],
    })
  );

  it('holds the gap off the transition, and off every wall', () => {
    const closest = Math.min(
      ...layout.planks.flatMap((p) => p.corners.map((c) => clearance(plankArea, c)))
    );
    expect(closest).toBeGreaterThan(gapFt - 1e-9);
  });

  it('leaves no bare floor beyond the gap along the transition', () => {
    // The defect: a break landing a hair from where the run already ended cut off a piece too
    // small to lay, the emit dropped it, and the floor stopped 0.42" from the wall where a
    // quarter inch was asked for. Walk the boundary and find the first board inward.
    // The floor is the region eroded by the gap, so *every* point a gap inside the boundary is a
    // point a board has to reach. Sampling just inside that edge is the tightest place to ask,
    // and asking it this way needs no exception at a corner: a point near one that is short of
    // the gap from the adjoining edge is not in the eroded region at all, and drops out by the
    // same test rather than by an angle-dependent margin guessed per vertex.
    const index = new PlankIndex(layout);
    let checked = 0;
    for (let i = 0; i < plankArea.length; i++) {
      const a = plankArea[i];
      const b = plankArea[(i + 1) % plankArea.length];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const nx = -(b.y - a.y) / len;
      const ny = (b.x - a.x) / len;
      for (let s = 0.02; s < len; s += 0.02) {
        const depth = gapFt + 0.004;
        const q = {
          x: a.x + ((b.x - a.x) * s) / len + nx * depth,
          y: a.y + ((b.y - a.y) * s) / len + ny * depth,
        };
        if (clearance(plankArea, q) < gapFt) continue;
        checked += 1;
        // Before the break tolerance this was bare for the first 0.3ft of the bottom wall beside
        // the transition, and the floor stopped 0.42" from it where a quarter inch was asked for.
        expect(index.at(q), `edge ${i} at ${s.toFixed(2)}ft`).not.toBeNull();
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('lays the board beside the transition whole, with its corner taken off', () => {
    // The board at the transition is one piece of full nominal width whose end bends.
    const bent = layout.planks.filter((p) => p.corners.length > 4);
    expect(bent.length).toBeGreaterThan(0);
    expect(
      bent.some((p) => Math.abs(p.width * INCHES_PER_FOOT - defaults.plank.widthIn) < 1e-6)
    ).toBe(true);
  });

  it('never saws one board into two strips down its length', () => {
    // The signature of the defect: two boards of one row, stacked across the width, whose widths
    // add to one plank. That is a board someone ripped lengthwise, which is what refusing to join
    // across a bend produced — first because the ends turned, then because their long points
    // disagreed by the depth of the corner being taken off.
    const plankWidth = defaults.plank.widthIn / INCHES_PER_FOOT;
    for (const a of layout.planks) {
      for (const b of layout.planks) {
        if (a.id === b.id || a.row !== b.row) continue;
        const stacked =
          Math.abs(a.width + b.width - plankWidth) < 1e-6 &&
          // Overlapping along the run — the two halves of one board, not two boards end to end.
          Math.min(a.length, b.length) > 0 &&
          Math.abs(a.center.x - b.center.x) + Math.abs(a.center.y - b.center.y) < plankWidth;
        expect(stacked, `${a.id} and ${b.id}`).toBe(false);
      }
    }
  });
});
