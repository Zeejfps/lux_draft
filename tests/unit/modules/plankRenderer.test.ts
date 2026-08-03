import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { PlankRenderer } from '../../../src/modules/flooring/rendering/PlankRenderer';
import type { Plank, PlankLayout } from '../../../src/modules/flooring/PlankLayoutEngine';
import { EMPTY_LAYOUT } from '../../../src/modules/flooring/PlankLayoutEngine';

/**
 * The renderer's colour path, asserted on the buffers rather than on pixels.
 *
 * These are regression tests for a floor that drew entirely black for want of one material flag,
 * which no test caught because every value being *written* was correct — the loss happened in the
 * shader. So the first test asserts the material contract that makes `instanceColor` reach the
 * fragment stage at all, and the rest assert what gets written into it.
 */

function plank(over: Partial<Plank> = {}): Plank {
  const corner = { x: 0, y: 0 };
  return {
    id: 'p0:0',
    row: 0,
    column: 0,
    center: { x: 0, y: 0 },
    length: 4,
    width: 0.583,
    corners: [corner, corner, corner, corner],
    cut: false,
    narrow: false,
    ...over,
  };
}

const layoutOf = (planks: Plank[]): PlankLayout => ({ ...EMPTY_LAYOUT, planks });

/** The fill mesh is the first child; the seam mesh is the second. */
function fillMesh(scene: THREE.Scene): THREE.InstancedMesh {
  const group = scene.children[0] as THREE.Group;
  return group.children[0] as THREE.InstancedMesh;
}

function colorAt(scene: THREE.Scene, i: number): THREE.Color {
  const attribute = fillMesh(scene).instanceColor;
  if (!attribute) throw new Error('no instanceColor');
  return new THREE.Color(attribute.getX(i), attribute.getY(i), attribute.getZ(i));
}

const hex = (c: THREE.Color): string => `#${c.getHexString()}`;

describe('the plank fill material', () => {
  /**
   * The bug this exists for: three derives `USE_COLOR` from `material.vertexColors` alone in the
   * vertex stage and from `vertexColors || instancingColor` in the fragment stage. Setting
   * `vertexColors` on a geometry with no `color` attribute therefore makes the vertex shader run
   * `vColor *= color` against a missing attribute — `(0, 0, 0)` — and the `vColor *= instanceColor`
   * that follows multiplies into zero. Every plank draws black and every tint below is discarded.
   */
  it('does not ask for vertex colours, which would zero the instance colour', () => {
    const scene = new THREE.Scene();
    const renderer = new PlankRenderer(scene);
    const material = fillMesh(scene).material as THREE.MeshBasicMaterial;
    expect(material.vertexColors).toBe(false);
    // ...and the per-instance tint it relies on instead is actually allocated.
    expect(fillMesh(scene).instanceColor).not.toBeNull();
    renderer.dispose();
  });
});

describe('the plank tints', () => {
  const scene = new THREE.Scene();
  const renderer = new PlankRenderer(scene);
  renderer.update(
    layoutOf([
      plank({ id: 'full-even', row: 0 }),
      plank({ id: 'full-odd', row: 1 }),
      plank({ id: 'cut', row: 2, cut: true }),
      plank({ id: 'narrow', row: 3, cut: true, narrow: true, width: 0.125 }),
    ])
  );

  it('gives a narrow board its own colour, distinct from the wood tints', () => {
    const narrow = colorAt(scene, 3);
    for (const i of [0, 1, 2]) expect(hex(colorAt(scene, i))).not.toBe(hex(narrow));
    // Red, not another tan: the whole point is that it is findable among the wood.
    expect(narrow.r).toBeGreaterThan(narrow.g * 2);
  });

  it('ranks narrow above cut, since a sliver is the more useful thing to see', () => {
    expect(hex(colorAt(scene, 3))).not.toBe(hex(colorAt(scene, 2)));
  });

  it('keeps the narrow colour through a hover that lands elsewhere', () => {
    // The hover path recolours every instance; it used to be a second copy of the tint ternary,
    // which is exactly how a new tint survives the first paint and vanishes on the first
    // pointer move.
    const before = hex(colorAt(scene, 3));
    renderer.setHovered('full-even');
    expect(hex(colorAt(scene, 3))).toBe(before);
    expect(hex(colorAt(scene, 0))).not.toBe(before);
  });
});
