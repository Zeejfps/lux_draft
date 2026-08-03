import { describe, it, expect } from 'vitest';
import { createThickLine } from '../../../src/floorplan/utils/three';

/** Number of quads in the ribbon — 4 vertices and 6 indices each. */
function quadCount(mesh: ReturnType<typeof createThickLine>): number {
  return mesh.geometry.getAttribute('position').count / 4;
}

describe('createThickLine', () => {
  it('emits one quad per segment for a solid line', () => {
    const mesh = createThickLine(
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
      ],
      { color: 0xffffff, width: 0.1 }
    );

    expect(quadCount(mesh)).toBe(2);
    expect(mesh.geometry.getIndex()?.count).toBe(12);
  });

  it('offsets vertices by half the width perpendicular to the segment', () => {
    const mesh = createThickLine(
      [
        { x: 0, y: 0 },
        { x: 2, y: 0 },
      ],
      { color: 0xffffff, width: 0.4, z: 0.2 }
    );

    const position = mesh.geometry.getAttribute('position');
    // Horizontal segment: the two start vertices straddle y = ±0.2, both at the given z.
    expect(position.getY(0)).toBeCloseTo(0.2, 6);
    expect(position.getY(1)).toBeCloseTo(-0.2, 6);
    expect(position.getZ(0)).toBeCloseTo(0.2, 6);
  });

  it('splits a dashed line into one quad per dash', () => {
    // 10 long, period 2 (1 on, 1 off) => dashes at [0,1] [2,3] ... [8,9] = 5 quads.
    const mesh = createThickLine(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      { color: 0xffffff, width: 0.1, dash: { dashSize: 1, gapSize: 1 } }
    );

    expect(quadCount(mesh)).toBe(5);
  });

  it('carries the dash phase across polyline joins', () => {
    // Two collinear 5-long segments must dash exactly like one 10-long segment.
    const split = createThickLine(
      [
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 10, y: 0 },
      ],
      { color: 0xffffff, width: 0.1, dash: { dashSize: 1, gapSize: 1 } }
    );

    expect(quadCount(split)).toBe(5);
  });

  it('terminates on dash sizes that are inexact in binary', () => {
    // Regression: walking the segment with an accumulated cursor hung here. At 1.15 along,
    // the position within the period rounds to 0.1499999999999999 — a hair under dashSize —
    // so the next dash was ~1e-16 long, too small to advance a float, and the walk spun.
    const mesh = createThickLine(
      [
        { x: 0, y: 0 },
        { x: 3, y: 0 },
      ],
      { color: 0xffffff, width: 0.07, dash: { dashSize: 0.15, gapSize: 0.1 } }
    );

    expect(quadCount(mesh)).toBe(12);
  });

  it('terminates for every length along a realistic measurement', () => {
    for (let length = 0.05; length <= 40; length += 0.05) {
      const mesh = createThickLine(
        [
          { x: 0, y: 0 },
          { x: length, y: 0 },
        ],
        { color: 0xffffff, width: 0.07, dash: { dashSize: 0.15, gapSize: 0.1 } }
      );
      expect(quadCount(mesh)).toBeGreaterThan(0);
    }
  });

  it('falls back to solid rather than emitting unbounded dash geometry', () => {
    const mesh = createThickLine(
      [
        { x: 0, y: 0 },
        { x: 1000, y: 0 },
      ],
      { color: 0xffffff, width: 0.1, dash: { dashSize: 1e-4, gapSize: 1e-4 } }
    );

    expect(quadCount(mesh)).toBe(1);
  });

  it('skips zero-length segments instead of emitting degenerate quads', () => {
    const mesh = createThickLine(
      [
        { x: 1, y: 1 },
        { x: 1, y: 1 },
        { x: 2, y: 1 },
      ],
      { color: 0xffffff, width: 0.1 }
    );

    expect(quadCount(mesh)).toBe(1);
  });

  it('treats a zero dash size as solid rather than looping forever', () => {
    const mesh = createThickLine(
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ],
      { color: 0xffffff, width: 0.1, dash: { dashSize: 0, gapSize: 1 } }
    );

    expect(quadCount(mesh)).toBe(1);
  });
});
