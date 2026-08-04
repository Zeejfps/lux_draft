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
    ripped: false,
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

describe('a pinned board is visible without being hovered', () => {
  const scene = new THREE.Scene();
  const renderer = new PlankRenderer(scene);
  const planks = [
    plank({ id: 'plain', row: 0 }),
    plank({ id: 'held', row: 1, cut: true }),
    plank({ id: 'held-sliver', row: 2, cut: true, narrow: true, ripped: true, width: 0.125 }),
  ];
  renderer.update({ ...EMPTY_LAYOUT, planks, pinnedIds: ['held', 'held-sliver'] });

  it('accents the board a pin landed on, distinctly from the wood and the cut tints', () => {
    const held = colorAt(scene, 1);
    expect(hex(held)).not.toBe(hex(colorAt(scene, 0)));
    // Violet: neither of the two blues, which come and go with the pointer, nor a tan.
    expect(held.b).toBeGreaterThan(held.g * 2);
  });

  it('still shows a pinned sliver as a sliver, since that is the case to see', () => {
    const sliver = colorAt(scene, 2);
    expect(sliver.r).toBeGreaterThan(sliver.b * 2);
    expect(hex(sliver)).not.toBe(hex(colorAt(scene, 1)));
  });

  it('survives the colour-only hover path, which is a separate walk of the same tint', () => {
    const before = hex(colorAt(scene, 1));
    renderer.setHovered('plain');
    expect(hex(colorAt(scene, 1))).toBe(before);
  });

  it('gives the accent back when the pin is cleared', () => {
    renderer.setHovered(null);
    renderer.update({ ...EMPTY_LAYOUT, planks });
    expect(hex(colorAt(scene, 1))).not.toBe(hex(colorAt(scene, 0)));
    // …to the ordinary cut tint, not to the violet it was holding.
    const cutTint = colorAt(scene, 1);
    expect(cutTint.b).toBeLessThan(cutTint.g);
  });
});

/**
 * A board whose end bends is one board and several instances.
 *
 * The renderer draws quads, and a quad's ends are each one straight cut — so a board with a
 * corner clipped at a transition is drawn as one instance per segment of its end profile. What
 * must not follow from that is a board that reads as two: the instances share a tint, they share
 * the hover, and the seam is taken off the board's outer boundary only, never off the joint
 * between two segments of one board — which is not a joint at all.
 */
describe('a board whose end bends', () => {
  /** A pentagon: a 4 x 0.583 board with a corner taken off its start end. */
  const bentPlank = plank({
    id: 'bent',
    center: { x: 0, y: 0 },
    length: 4,
    width: 0.583,
    cut: true,
    corners: [
      { x: -2, y: -0.2915 },
      { x: 2, y: -0.2915 },
      { x: 2, y: 0 },
      { x: 2, y: 0.2915 },
      { x: -1.5, y: 0.2915 },
      { x: -2, y: 0 },
    ],
  });

  it('draws one instance per segment, and one for an ordinary board', () => {
    const scene = new THREE.Scene();
    const renderer = new PlankRenderer(scene);
    renderer.update(layoutOf([plank({ id: 'plain' }), bentPlank]));
    // One for the plain board, two for the bent one.
    expect(fillMesh(scene).count).toBe(3);
    renderer.dispose();
  });

  it('gives every segment of one board the same tint, and hovers them together', () => {
    const scene = new THREE.Scene();
    const renderer = new PlankRenderer(scene);
    renderer.update(layoutOf([plank({ id: 'plain' }), bentPlank]));
    expect(hex(colorAt(scene, 1))).toBe(hex(colorAt(scene, 2)));

    renderer.setHovered('bent');
    expect(hex(colorAt(scene, 1))).toBe(hex(colorAt(scene, 2)));
    // ...and it is the hover colour, not the tint they merely agreed on before.
    expect(hex(colorAt(scene, 1))).not.toBe(hex(colorAt(scene, 0)));
    renderer.dispose();
  });
});

describe('the picked board', () => {
  const build = () => {
    const scene = new THREE.Scene();
    const renderer = new PlankRenderer(scene);
    renderer.update(layoutOf([plank({ id: 'a', row: 0 }), plank({ id: 'b', row: 1 })]));
    return { scene, renderer };
  };

  it('keeps its highlight while the pointer wanders onto another board', () => {
    // The pick outranks the hover, or reading a board's dimensions would mean holding the mouse
    // still on it — and the panel would be describing a board with no mark on the floor.
    const { scene, renderer } = build();
    renderer.setSelected('a');
    const picked = hex(colorAt(scene, 0));
    renderer.setHovered('b');
    expect(hex(colorAt(scene, 0))).toBe(picked);
    // ...and the hovered one still reads as hovered, distinctly from the pick.
    expect(hex(colorAt(scene, 1))).not.toBe(picked);
    expect(hex(colorAt(scene, 1))).not.toBe(hex(colorAt(scene, 0)));
    renderer.dispose();
  });

  it('outranks the hover on the same board, and is given back when cleared', () => {
    const { scene, renderer } = build();
    renderer.setHovered('a');
    const hovered = hex(colorAt(scene, 0));
    renderer.setSelected('a');
    expect(hex(colorAt(scene, 0))).not.toBe(hovered);
    renderer.setSelected(null);
    expect(hex(colorAt(scene, 0))).toBe(hovered);
    renderer.dispose();
  });
});
