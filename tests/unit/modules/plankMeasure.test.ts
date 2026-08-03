import { describe, it, expect } from 'vitest';
import type { LayoutInputs } from '../../../src/modules/flooring/PlankLayoutEngine';
import { computePlankLayout } from '../../../src/modules/flooring/PlankLayoutEngine';
import { measurePlank } from '../../../src/modules/flooring/plankMeasure';
import { defaultFlooringData } from '../../../src/modules/flooring/codec';
import { INCHES_PER_FOOT } from '../../../src/modules/flooring/types';
import { rectWalls } from '../../helpers/documents';

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

/**
 * `measurePlank` is what the board read-out prints, and the claim it makes is that it agrees with
 * the cut list — the same board, measured once while the floor is laid and once after the fact,
 * has to give the same figures or the panel and the list contradict each other on screen.
 */
describe('measuring one board', () => {
  it('reports a whole board as its stock size, square, with no short point', () => {
    const layout = computePlankLayout(inputs({ layout: { ...defaults.layout, runAngleDeg: 0 } }));
    const whole = layout.planks.find((p) => !p.cut);
    expect(whole).toBeDefined();

    const m = measurePlank(whole!, layout.angle);
    expect(m.longIn).toBeCloseTo(defaults.plank.lengthIn, 6);
    expect(m.shortIn).toBeCloseTo(m.longIn, 6);
    expect(m.widthIn).toBeCloseTo(defaults.plank.widthIn, 6);
    expect(m.angleDeg).toBe(0);
    expect(m.mitred).toBe(false);
    // A rectangle, so the outline's area is the nominal one — 7" x 48" is 2 1/3 sq ft.
    expect(m.areaSqft).toBeCloseTo((defaults.plank.widthIn * defaults.plank.lengthIn) / 144, 6);
  });

  it('reports a rip as the narrower board it is', () => {
    const layout = computePlankLayout(inputs());
    const ripped = layout.planks.find((p) => p.width < defaults.plank.widthIn / INCHES_PER_FOOT);
    expect(ripped).toBeDefined();

    const m = measurePlank(ripped!, layout.angle);
    expect(m.widthIn).toBeLessThan(defaults.plank.widthIn);
    expect(m.widthIn).toBeCloseTo(ripped!.width * INCHES_PER_FOOT, 6);
  });

  it('gives a mitred board a long point, a short point and the saw angle', () => {
    // A run at 30° to a square room: every board against a wall is cut to a diagonal.
    const layout = computePlankLayout(
      inputs({ layout: { ...defaults.layout, runAngleDeg: 30, expansionGapIn: 0 } })
    );
    const measured = layout.planks.map((p) => measurePlank(p, layout.angle));
    const mitred = measured.filter((m) => m.mitred);
    expect(mitred.length).toBeGreaterThan(0);

    for (const m of mitred) {
      expect(m.shortIn).toBeLessThan(m.longIn);
      expect(m.angleDeg).toBeGreaterThan(0);
      // The area of the trapezoid, which is between the two points times the width — and below
      // the rectangle the long point alone would suggest.
      expect(m.areaSqft).toBeLessThan((m.longIn * m.widthIn) / 144 + 1e-9);
      expect(m.areaSqft).toBeGreaterThan((m.shortIn * m.widthIn) / 144 - 1e-9);
    }
  });

  it('agrees with the line the cut list holds for the same board', () => {
    const layout = computePlankLayout(
      inputs({ layout: { ...defaults.layout, runAngleDeg: 30, expansionGapIn: 0 } })
    );
    const eighth = (value: number): number => Math.round(value * 8) / 8;
    // Every measured cut piece has to be findable in the list, at the list's own resolution.
    for (const plank of layout.planks.filter((p) => p.cut)) {
      const m = measurePlank(plank, layout.angle);
      const line = layout.cutList.find(
        (entry) =>
          entry.lengthIn === eighth(m.longIn) &&
          (entry.shortIn ?? entry.lengthIn) === eighth(m.shortIn)
      );
      expect(line, `no cut list line for ${m.longIn}/${m.shortIn}`).toBeDefined();
    }
  });
});
