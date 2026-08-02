import { describe, it, expect } from 'vitest';
import type { Obstacle, Vector2, WallSegment } from '../../../src/floorplan/types/geometry';
import type { LayoutInputs } from '../../../src/modules/flooring/PlankLayoutEngine';
import { computePlankLayout, layoutKey } from '../../../src/modules/flooring/PlankLayoutEngine';
import { defaultFlooringData } from '../../../src/modules/flooring/codec';
import type { LayoutConfig, PlankSpec } from '../../../src/modules/flooring/types';
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
    const plank: PlankSpec = { widthIn: 0, lengthIn: 48, name: 'bad' };
    expect(computePlankLayout(inputs({ plank })).planks).toHaveLength(0);
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
    // 300 sq ft, less the one-row band that straddles the inside step: a row is sampled on
    // one line, so the band spanning y = 10 is laid as if the whole band were the narrow part.
    // The bound is (step length) x (one plank width); the actual error here is 0.83 sq ft. The
    // engine's doc comment names it — the price of a scan line over a polygon boolean — and it
    // under-reports rather than over-reports.
    expect(layout.coveredSqft).toBeLessThanOrEqual(300);
    expect(layout.coveredSqft).toBeGreaterThan(300 - 10 * (7 / 12));
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
    const walls = rectWalls(20, 20);
    const distanceToWalls = (p: Vector2): number =>
      Math.min(
        ...walls.map((w) => {
          const dx = w.end.x - w.start.x;
          const dy = w.end.y - w.start.y;
          const t = Math.max(
            0,
            Math.min(1, ((p.x - w.start.x) * dx + (p.y - w.start.y) * dy) / (dx * dx + dy * dy))
          );
          return Math.hypot(p.x - (w.start.x + t * dx), p.y - (w.start.y + t * dy));
        })
      );

    // The ends of each row's centreline — where the scan line meets the boundary, which is the
    // one place the row's extent is exact rather than sampled.
    const [c, s] = [Math.cos(layout.angle), Math.sin(layout.angle)];
    const ends = layout.planks.flatMap((p) => [
      { x: p.center.x - (p.length / 2) * c, y: p.center.y - (p.length / 2) * s },
      { x: p.center.x + (p.length / 2) * c, y: p.center.y + (p.length / 2) * s },
    ]);
    expect(Math.min(...ends.map(distanceToWalls))).toBeCloseTo(gap, 6);
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

  it('waste is what was bought and not installed', () => {
    const layout = layoutOf({});
    expect(layout.purchasedSqft).toBeGreaterThanOrEqual(layout.coveredSqft);
    expect(layout.wastePercent).toBeCloseTo(
      ((layout.purchasedSqft - layout.coveredSqft) / layout.purchasedSqft) * 100,
      9
    );
    expect(layout.wastePercent).toBeGreaterThanOrEqual(0);
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
    const plank: PlankSpec = { widthIn: 0.005, lengthIn: 0.005, name: 'absurd' };
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
      expect(highest).toBeCloseTo(8 - gapFt, 6);
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

describe('a wall that runs along the rows is not a transition', () => {
  /**
   * The room from the report, simplified: a rectangle with a notch dropping out of its bottom
   * edge, so the wall at x = -1 runs **along** the rows once the run is turned to 90°.
   *
   * The bug: the row grid was broken at every vertex of the region ring, and a region's ring is
   * mostly made of the room's own walls. That put a permanent row boundary on the notch wall —
   * a plank split down its length at an inside corner, fixed in world space, immune to both the
   * plank width and the layout origin, which is exactly how it was spotted.
   */
  const notched: Vector2[] = [
    { x: -6, y: 6 },
    { x: 6, y: 6 },
    { x: 6, y: -6 },
    { x: -1, y: -6 },
    { x: -1, y: -11 },
    { x: -6, y: -11 },
  ];
  const walls: WallSegment[] = notched.map((start, i) => {
    const end = notched[(i + 1) % notched.length];
    return { id: `w${i}`, start, end, length: Math.hypot(end.x - start.x, end.y - start.y) };
  });
  // A diagonal divider cutting off the notch, so the region clip is live.
  const region: Vector2[] = [
    { x: -6, y: 6 },
    { x: 6, y: 6 },
    { x: 6, y: -6 },
    { x: -1, y: -6 },
    { x: -6, y: -8 },
  ];

  /** Run 90°: rows stack along world x, so a row boundary is a world-x value. */
  const rowEdges = (widthIn: number, origin: Vector2): number[] => {
    const layout = computePlankLayout(
      inputs({
        walls,
        origin,
        plank: { ...defaults.plank, widthIn },
        layout: { ...defaults.layout, runAngleDeg: 90 },
        regions: [region],
      })
    );
    return [...new Set(layout.planks.map((p) => Number((p.center.x - p.width / 2).toFixed(9))))]
      .sort((a, b) => a - b)
      .filter((v) => v > -5.9 && v < 5.9);
  };

  it('puts no row boundary on the notch wall, whatever the plank width or the origin', () => {
    for (const widthIn of [7, 15.5]) {
      for (const origin of [
        { x: 0, y: 0 },
        { x: 0.68, y: 0.97 },
        { x: 2.5, y: -1.5 },
      ]) {
        const edges = rowEdges(widthIn, origin);
        expect(edges.length).toBeGreaterThan(3);
        // Every interior boundary lands on the grid the origin anchors — no stray one at the
        // notch wall (x = -1), and none anywhere else the room merely turns a corner.
        //
        // Every origin here is inside the room, where there is no wall to measure a gap from, so
        // the grid runs through the origin itself — see `anchorOf` in the engine.
        const step = widthIn / 12;
        const anchor = origin.x;
        for (const edge of edges) {
          const offGrid = Math.abs(edge - anchor - Math.round((edge - anchor) / step) * step);
          expect(offGrid).toBeLessThan(1e-6);
        }
      }
    }
  });

  it('still moves every boundary when the origin moves', () => {
    // The counterpart to the above: a boundary that ignored the origin was the symptom.
    const a = rowEdges(15.5, { x: 0, y: 0 });
    const b = rowEdges(15.5, { x: 0.4, y: 0 });
    for (const edge of a) expect(b).not.toContain(edge);
  });
});
