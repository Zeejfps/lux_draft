import { describe, it, expect } from 'vitest';
import type { Vector2 } from '../../../src/floorplan/types/geometry';
import type { RegionInputs } from '../../../src/modules/flooring/RegionSolver';
import {
  plankRings,
  regionInputsKey,
  solveRegions,
} from '../../../src/modules/flooring/RegionSolver';
import { nearestOnSegment, pointInPolygon } from '../../../src/modules/flooring/geometry2d';
import type { Divider, SurfaceAssignment } from '../../../src/modules/flooring/types';
import { rectWalls } from '../../helpers/documents';

/**
 * The solver as a pure table, exactly as `PlankLayoutEngine` is tested: no document, no store,
 * no THREE. Every assertion is a property of (boundary, dividers, surfaces), which is the claim
 * that the areas of a room are derived and not authored.
 *
 * The room throughout is 20 x 20 with its corners at (0,0) and (20,20).
 */

function divider(id: string, a: Vector2, b: Vector2): Divider {
  return { id, a, b, kind: 'tMolding' };
}

function inputs(over: Partial<RegionInputs> = {}): RegionInputs {
  return {
    walls: rectWalls(20, 20),
    isClosed: true,
    dividers: [],
    surfaces: [],
    ...over,
  };
}

/** The area whose ring contains this point. Faces have no ids, so this is how a test names one. */
function regionAt(solution: ReturnType<typeof solveRegions>, p: Vector2) {
  return solution.regions.find((region) => pointInPolygon(region.ring, p));
}

const carpet = (seed: Vector2): SurfaceAssignment => ({ seed, surface: 'carpet' });

describe('a room with no dividers', () => {
  it('is one area of plank', () => {
    const solution = solveRegions(inputs());
    expect(solution.regions).toHaveLength(1);
    expect(solution.regions[0].surface).toBe('plank');
    expect(solution.regions[0].areaSqft).toBeCloseTo(400, 6);
    expect(solution.transitions).toHaveLength(0);
  });

  it('reports the whole room to the engine — not a ring that happens to match it', () => {
    // `null` and "one ring covering everything" lay the same floor but key differently, and the
    // pre-divider document must take the cheap path.
    expect(plankRings(solveRegions(inputs()))).toBeNull();
  });

  it('has no areas at all when the boundary is open', () => {
    expect(solveRegions(inputs({ isClosed: false })).regions).toHaveLength(0);
    expect(solveRegions(inputs({ walls: rectWalls(20, 20).slice(0, 2) })).regions).toHaveLength(0);
  });
});

describe('one divider', () => {
  const across = [divider('d1', { x: 0, y: 8 }, { x: 20, y: 8 })];

  it('splits the room in two, and the two halves add up', () => {
    const solution = solveRegions(inputs({ dividers: across }));
    expect(solution.regions).toHaveLength(2);
    expect(solution.unattached).toHaveLength(0);
    const total = solution.regions.reduce((sum, r) => sum + r.areaSqft, 0);
    expect(total).toBeCloseTo(400, 6);
    expect(regionAt(solution, { x: 10, y: 4 })!.areaSqft).toBeCloseTo(160, 6);
    expect(regionAt(solution, { x: 10, y: 14 })!.areaSqft).toBeCloseTo(240, 6);
  });

  it('is not a transition while the same floor runs either side of it', () => {
    // The line exists; the trim does not. This is the difference between a divider and a
    // transition, and it is why transitions are derived rather than stored alongside dividers.
    expect(solveRegions(inputs({ dividers: across })).transitions).toHaveLength(0);
  });

  it('becomes a transition as soon as the surfaces differ', () => {
    const solution = solveRegions(
      inputs({ dividers: across, surfaces: [carpet({ x: 10, y: 14 })] })
    );
    expect(solution.transitions).toHaveLength(1);
    const [transition] = solution.transitions;
    expect(transition.dividerId).toBe('d1');
    expect([transition.from, transition.to].sort()).toEqual(['carpet', 'plank']);
    expect(transition.start.y).toBeCloseTo(8, 6);
    expect(transition.end.y).toBeCloseTo(8, 6);
    expect(Math.abs(transition.end.x - transition.start.x)).toBeCloseTo(20, 6);
  });

  it('hands the engine only the plank side', () => {
    const solution = solveRegions(
      inputs({ dividers: across, surfaces: [carpet({ x: 10, y: 14 })] })
    );
    const rings = plankRings(solution)!;
    expect(rings).toHaveLength(1);
    expect(pointInPolygon(rings[0], { x: 10, y: 4 })).toBe(true);
    expect(pointInPolygon(rings[0], { x: 10, y: 14 })).toBe(false);
  });

  it('hands the engine an empty list when nothing is plank — not "everywhere"', () => {
    const rings = plankRings(
      solveRegions(
        inputs({
          dividers: across,
          surfaces: [carpet({ x: 10, y: 4 }), carpet({ x: 10, y: 14 })],
        })
      )
    );
    expect(rings).toEqual([]);
  });

  it('splits a diagonal chord too', () => {
    const solution = solveRegions(
      inputs({ dividers: [divider('d1', { x: 0, y: 0 }, { x: 20, y: 20 })] })
    );
    expect(solution.regions).toHaveLength(2);
    for (const region of solution.regions) expect(region.areaSqft).toBeCloseTo(200, 6);
  });
});

describe('endpoints that do not land exactly on a wall', () => {
  it('attaches anyway, within tolerance — a wall moved, the intent did not', () => {
    const solution = solveRegions(
      inputs({ dividers: [divider('d1', { x: 0.4, y: 8 }, { x: 19.6, y: 8 })] })
    );
    expect(solution.unattached).toHaveLength(0);
    expect(solution.regions).toHaveLength(2);
    // Projected onto the walls, so the split is still clean and the areas still total.
    expect(solution.regions.reduce((sum, r) => sum + r.areaSqft, 0)).toBeCloseTo(400, 6);
  });

  it('reports a divider that reaches nothing rather than half-splitting the room', () => {
    const solution = solveRegions(
      inputs({ dividers: [divider('d1', { x: 6, y: 8 }, { x: 14, y: 8 })] })
    );
    expect(solution.unattached).toEqual(['d1']);
    expect(solution.regions).toHaveLength(1);
    expect(solution.transitions).toHaveLength(0);
  });

  /**
   * The line the user drew is the line the floor is cut to.
   *
   * A perpendicular foot is clamped to the edge it is dropped on, so an endpoint that overshoots
   * a wall's end lands on that wall's *corner* — and the chord through it is then a different
   * line from the one on screen. In a real document an endpoint an inch inside the room attached
   * to the corner beside it and tilted the chord 0.037" off the drawn line over five feet, which
   * the layout engine then held its expansion gap against perfectly: 0.247" at one end of the
   * transition and 0.217" at the other, against the quarter inch asked for, with nothing wrong
   * anywhere except the boundary it had been given.
   *
   * So an endpoint short of the wall is extended along the divider's own direction instead.
   */
  it('extends a short endpoint along the divider, not sideways onto the nearest wall', () => {
    // A chord from (0, 5) to (20, 15), with its left end pulled half a foot back along itself.
    const back = 0.5 / Math.hypot(20, 10);
    const pulled = { x: 20 * back, y: 5 + 10 * back };
    const solution = solveRegions({
      ...inputs({ dividers: [divider('d1', pulled, { x: 20, y: 15 })] }),
      surfaces: [carpet({ x: 10, y: 2 })],
    });
    expect(solution.unattached).toHaveLength(0);
    expect(solution.transitions).toHaveLength(1);

    const { start, end } = solution.transitions[0];
    // The endpoint reaches the left wall at y = 5, where the drawn line meets it — not at the
    // pulled endpoint's own height, which is where a perpendicular would have put it.
    const left = Math.abs(start.x) < Math.abs(end.x) ? start : end;
    expect(left.x).toBeCloseTo(0, 9);
    expect(left.y).toBeCloseTo(5, 9);
    expect(left.y).not.toBeCloseTo(pulled.y, 3);

    // Stated as the property: both drawn endpoints lie on the placed transition's line.
    for (const p of [pulled, { x: 20, y: 15 }]) {
      expect(nearestOnSegment(start, end, p).distance).toBeLessThan(1e-9);
    }
  });

  it('rejects a chord lying along a single wall', () => {
    const solution = solveRegions(
      inputs({ dividers: [divider('d1', { x: 2, y: 0 }, { x: 18, y: 0 })] })
    );
    expect(solution.unattached).toEqual(['d1']);
    expect(solution.regions).toHaveLength(1);
  });
});

describe('two dividers', () => {
  it('makes three areas from two parallel cuts', () => {
    const solution = solveRegions(
      inputs({
        dividers: [
          divider('d1', { x: 0, y: 6 }, { x: 20, y: 6 }),
          divider('d2', { x: 0, y: 14 }, { x: 20, y: 14 }),
        ],
      })
    );
    expect(solution.regions).toHaveLength(3);
    expect(regionAt(solution, { x: 10, y: 10 })!.areaSqft).toBeCloseTo(160, 6);
  });

  it('T-joins the second onto the first', () => {
    // `d2` ends on `d1`, which exists only because `d1` was applied first. Document order is
    // dependency order, which is why `addDivider` appends.
    const solution = solveRegions(
      inputs({
        dividers: [
          divider('d1', { x: 0, y: 10 }, { x: 20, y: 10 }),
          divider('d2', { x: 10, y: 10 }, { x: 10, y: 20 }),
        ],
      })
    );
    expect(solution.unattached).toHaveLength(0);
    expect(solution.regions).toHaveLength(3);
    expect(regionAt(solution, { x: 10, y: 5 })!.areaSqft).toBeCloseTo(200, 6);
    expect(regionAt(solution, { x: 5, y: 15 })!.areaSqft).toBeCloseTo(100, 6);
    expect(regionAt(solution, { x: 15, y: 15 })!.areaSqft).toBeCloseTo(100, 6);
  });

  it('does not attach a divider that needs a later one to exist first', () => {
    const solution = solveRegions(
      inputs({
        dividers: [
          divider('d2', { x: 10, y: 10 }, { x: 10, y: 20 }),
          divider('d1', { x: 0, y: 10 }, { x: 20, y: 10 }),
        ],
      })
    );
    // `d2` has one end in open space when it is applied; the failure is reported, not silent.
    expect(solution.unattached).toEqual(['d2']);
    expect(solution.regions).toHaveLength(2);
  });

  it('cuts one divider into transition and non-transition stretches', () => {
    // Carpet in the top-left quarter only: `d1` is trim under that quarter and bare line under
    // the other. One divider, one transition segment covering half of it.
    const solution = solveRegions(
      inputs({
        dividers: [
          divider('d1', { x: 0, y: 10 }, { x: 20, y: 10 }),
          divider('d2', { x: 10, y: 10 }, { x: 10, y: 20 }),
        ],
        // The full list, as `setRegionSurface` always writes it: every area named, so nothing
        // is left to inherit.
        surfaces: [
          { seed: { x: 10, y: 5 }, surface: 'plank' },
          carpet({ x: 5, y: 15 }),
          { seed: { x: 15, y: 15 }, surface: 'plank' },
        ],
      })
    );
    const onD1 = solution.transitions.filter((t) => t.dividerId === 'd1');
    expect(onD1).toHaveLength(1);
    const length = Math.hypot(onD1[0].end.x - onD1[0].start.x, onD1[0].end.y - onD1[0].start.y);
    expect(length).toBeCloseTo(10, 6);
    expect(Math.min(onD1[0].start.x, onD1[0].end.x)).toBeCloseTo(0, 6);

    // And `d2` is trim along its whole length: carpet on one side, plank on the other.
    const onD2 = solution.transitions.filter((t) => t.dividerId === 'd2');
    expect(onD2).toHaveLength(1);
    expect(
      Math.hypot(onD2[0].end.x - onD2[0].start.x, onD2[0].end.y - onD2[0].start.y)
    ).toBeCloseTo(10, 6);
  });
});

describe('surface assignments', () => {
  const across = [divider('d1', { x: 0, y: 8 }, { x: 20, y: 8 })];

  it('is resolved by containment, not by index — the seed can be anywhere inside', () => {
    for (const seed of [
      { x: 1, y: 9 },
      { x: 10, y: 14 },
      { x: 19, y: 19 },
    ] as Vector2[]) {
      const solution = solveRegions(inputs({ dividers: across, surfaces: [carpet(seed)] }));
      expect(regionAt(solution, { x: 10, y: 14 })!.surface).toBe('carpet');
      expect(regionAt(solution, { x: 10, y: 4 })!.surface).toBe('plank');
    }
  });

  it('ignores a seed that is inside no area', () => {
    const solution = solveRegions(
      inputs({ dividers: across, surfaces: [carpet({ x: 50, y: 50 })] })
    );
    expect(solution.regions.every((region) => region.surface === 'plank')).toBe(true);
  });

  it('is inherited by both halves when an assigned area is subdivided', () => {
    // The point of inheriting: marking the top carpet and *then* splitting it must not silently
    // turn half of it back into this floor. Note where the seed lands — (10, 15) is the top
    // area's centroid, and the new divider runs straight through it, so which half "contains"
    // it is a coin toss on an edge. Inheritance is what makes that not matter: whichever half
    // does not claim the seed inherits the same surface anyway.
    const solution = solveRegions(
      inputs({
        dividers: [
          divider('d1', { x: 0, y: 10 }, { x: 20, y: 10 }),
          divider('d2', { x: 10, y: 10 }, { x: 10, y: 20 }),
        ],
        surfaces: [carpet({ x: 10, y: 15 })],
      })
    );
    expect(regionAt(solution, { x: 5, y: 15 })!.surface).toBe('carpet');
    expect(regionAt(solution, { x: 15, y: 15 })!.surface).toBe('carpet');
    expect(regionAt(solution, { x: 10, y: 5 })!.surface).toBe('plank');
  });

  it('lets an explicit seed override what would have been inherited', () => {
    const solution = solveRegions(
      inputs({
        dividers: [
          divider('d1', { x: 0, y: 10 }, { x: 20, y: 10 }),
          divider('d2', { x: 10, y: 10 }, { x: 10, y: 20 }),
        ],
        surfaces: [carpet({ x: 5, y: 15 }), { seed: { x: 15, y: 15 }, surface: 'tile' }],
      })
    );
    expect(regionAt(solution, { x: 5, y: 15 })!.surface).toBe('carpet');
    expect(regionAt(solution, { x: 15, y: 15 })!.surface).toBe('tile');
  });

  it('gives every area a seed that is actually inside it', () => {
    // The seed is what an assignment is stored against, so a seed outside its own face would
    // make the assignment unaddressable. An L is the case a centroid gets wrong.
    const lShape = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 6 },
      { x: 6, y: 6 },
      { x: 6, y: 20 },
      { x: 0, y: 20 },
    ];
    const walls = lShape.map((start, i) => {
      const end = lShape[(i + 1) % lShape.length];
      return {
        id: `w${i}`,
        start,
        end,
        length: Math.hypot(end.x - start.x, end.y - start.y),
      };
    });
    const solution = solveRegions(inputs({ walls }));
    expect(solution.regions).toHaveLength(1);
    expect(pointInPolygon(solution.regions[0].ring, solution.regions[0].seed)).toBe(true);
  });
});

describe('the structural key', () => {
  it('is the same string for the same inputs, whichever route got there', () => {
    const a = inputs({ dividers: [divider('d1', { x: 0, y: 8 }, { x: 20, y: 8 })] });
    const b = inputs({ dividers: [divider('d1', { x: 0, y: 8 }, { x: 20, y: 8 })] });
    expect(regionInputsKey(a)).toBe(regionInputsKey(b));
  });

  it('changes when a divider moves, when one is added, and when a surface changes', () => {
    const base = inputs({ dividers: [divider('d1', { x: 0, y: 8 }, { x: 20, y: 8 })] });
    const moved = inputs({ dividers: [divider('d1', { x: 0, y: 9 }, { x: 20, y: 9 })] });
    const painted = inputs({
      dividers: [divider('d1', { x: 0, y: 8 }, { x: 20, y: 8 })],
      surfaces: [carpet({ x: 10, y: 14 })],
    });
    expect(regionInputsKey(moved)).not.toBe(regionInputsKey(base));
    expect(regionInputsKey(painted)).not.toBe(regionInputsKey(base));
  });
});

describe('what the engine consumes', () => {
  /** An explicit assignment, so a face does not merely inherit its parent's surface. */
  const plank = (seed: Vector2): SurfaceAssignment => ({ seed, surface: 'plank' });

  /**
   * The engine takes the expansion gap out of every ring it is handed, so a floor handed over as
   * two abutting rings comes back with a bare stripe two gaps wide down the middle of it and a
   * row break along the seam. A divider with the same surface on both sides is not a transition —
   * that is this module's own definition of one — so it must not reach the engine as a seam.
   */
  it('merges same-surface areas into one ring', () => {
    // Two dividers, three faces: plank | plank | carpet. The first divider is not a transition.
    const solution = solveRegions(
      inputs({
        dividers: [
          divider('d1', { x: 0, y: 8 }, { x: 20, y: 8 }),
          divider('d2', { x: 0, y: 14 }, { x: 20, y: 14 }),
        ],
        surfaces: [carpet({ x: 10, y: 17 }), plank({ x: 10, y: 11 })],
      })
    );
    expect(solution.regions).toHaveLength(3);
    expect(solution.regions.filter((r) => r.surface === 'plank')).toHaveLength(2);

    const rings = plankRings(solution)!;
    expect(rings).toHaveLength(1);
    // One rectangle from the floor to the carpet, with no vertices left behind on the seam.
    expect(rings[0]).toHaveLength(4);
    expect(pointInPolygon(rings[0], { x: 10, y: 4 })).toBe(true);
    expect(pointInPolygon(rings[0], { x: 10, y: 8 })).toBe(true);
    expect(pointInPolygon(rings[0], { x: 10, y: 12 })).toBe(true);
    expect(pointInPolygon(rings[0], { x: 10, y: 17 })).toBe(false);
  });

  it('merges across a T-junction, where one face meets two', () => {
    // A spine at y=8 and a stem above it, so the lower face meets two upper ones along a single
    // long edge. Only the far corner is carpet.
    const solution = solveRegions(
      inputs({
        dividers: [
          divider('d1', { x: 0, y: 8 }, { x: 20, y: 8 }),
          divider('d2', { x: 10, y: 8 }, { x: 10, y: 20 }),
        ],
        surfaces: [carpet({ x: 15, y: 14 }), plank({ x: 5, y: 14 })],
      })
    );
    const rings = plankRings(solution)!;
    expect(rings).toHaveLength(1);
    expect(pointInPolygon(rings[0], { x: 5, y: 4 })).toBe(true);
    expect(pointInPolygon(rings[0], { x: 15, y: 4 })).toBe(true);
    expect(pointInPolygon(rings[0], { x: 5, y: 14 })).toBe(true);
    expect(pointInPolygon(rings[0], { x: 15, y: 14 })).toBe(false);
  });

  it('leaves genuinely separate areas separate', () => {
    // Carpet through the middle: the plank either side of it is two floors, not one.
    const solution = solveRegions(
      inputs({
        dividers: [
          divider('d1', { x: 0, y: 8 }, { x: 20, y: 8 }),
          divider('d2', { x: 0, y: 12 }, { x: 20, y: 12 }),
        ],
        surfaces: [carpet({ x: 10, y: 10 }), plank({ x: 10, y: 16 })],
      })
    );
    const rings = plankRings(solution)!;
    expect(rings).toHaveLength(2);
    expect(rings.filter((ring) => pointInPolygon(ring, { x: 10, y: 4 }))).toHaveLength(1);
    expect(rings.filter((ring) => pointInPolygon(ring, { x: 10, y: 16 }))).toHaveLength(1);
    expect(rings.some((ring) => pointInPolygon(ring, { x: 10, y: 10 }))).toBe(false);
  });
});
