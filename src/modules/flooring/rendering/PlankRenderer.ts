import * as THREE from 'three';
import type { Plank, PlankLayout } from '../PlankLayoutEngine';
import { plankProfile } from '../PlankLayoutEngine';

/**
 * The floor, as a single `THREE.InstancedMesh`.
 *
 * Instanced **from the first commit**, as the plan requires, and the reason is arithmetic: the
 * existing renderers rebuild their meshes on every store change, which is fine at ~20 lights and
 * is not fine at 200+ planks. One mesh per plank would mean 200–700 draw calls, 700 geometries
 * and 700 materials torn down and rebuilt on every keystroke in the plank-width field. Here a
 * layout change writes 700 matrices into one buffer and flips one dirty flag; the draw call
 * count is two (fill and seams) regardless of the size of the floor.
 *
 * The instance count only ever grows — the buffer is reallocated when a layout needs more
 * instances and reused when it needs fewer, with `mesh.count` doing the truncation. That keeps
 * a wall drag, which re-derives the floor on every settled frame, allocation-free in the common
 * case.
 *
 * ## Sheared instances
 *
 * A piece cut to a boundary that is not square to the run is a trapezoid (`Plank.corners`), and
 * a scaled 1x1 plane cannot be one. Rather than give up instancing for a merged buffer rebuilt
 * every settled frame, each instance carries four extra floats — the along-run offset of its
 * left and right ends at the bottom and top edges of the board — and a vertex-shader chunk
 * injected with `onBeforeCompile` displaces `position.x` by the lerp of them. One geometry, one
 * draw call, the growth-only buffer policy and the colour-only hover path all unchanged.
 *
 * The offsets are normalised by the instance's own scale, and the fill's are taken from a quad
 * already pulled half a seam in from the board's ends. Scaling alone cannot inset them: the
 * shear is what decides where an end lands, so a fill that reconstructed the board's own ends
 * would sit flush against the seam quad and the joint between two boards would disappear.
 *
 * ## One instance per segment, not per board
 *
 * A sheared quad's end is one straight cut, and a board's end is not always one cut: where a
 * boundary bends across a board — a diagonal transition running into a wall — a corner comes off
 * an otherwise whole board and the outline is a pentagon. So an instance is a *segment* of
 * `plankProfile`, and the ordinary board, which has one, is unchanged.
 *
 * Two things then have to hold or the board reads as two boards, which is the very thing the
 * engine stopped doing. The segments share a tint and share the hover, through `owner`. And the
 * half-seam inset is taken off the board's **outer** boundary only — the line between two
 * segments of one board is not a joint, and insetting there would draw a seam down the middle of
 * a board that is not cut.
 */

const PLANK_COLOR = new THREE.Color(0xb98a56);
const PLANK_COLOR_ALT = new THREE.Color(0xa97c4c);
const CUT_PLANK_COLOR = new THREE.Color(0xc99a63);
const HOVER_COLOR = new THREE.Color(0x38bdf8);

/**
 * The board whose dimensions are being read out.
 *
 * A deeper tone of the hover blue rather than a different hue: the pointer is usually on the
 * picked board, so the two are seen together more often than apart, and they have to read as the
 * same gesture at two strengths — otherwise moving off a picked board looks like the pick moved.
 */
const SELECTED_COLOR = new THREE.Color(0x1d4ed8);

/**
 * A board ripped below the plank's `minRipWidthIn`.
 *
 * Red rather than another tan: the three wood tints above differ by a few percent of lightness
 * because they are all the same floor, and a sliver is the one thing on it that is a *defect*.
 * It has to be findable at a glance in a room of 700 boards, and against a floor that is entirely
 * warm mid-tones only a hue this far off it is.
 */
const NARROW_PLANK_COLOR = new THREE.Color(0xd9483b);

/**
 * The tint a plank draws at, before hover.
 *
 * One function, because the update loop and the hover path both need it and had drifted into two
 * copies of the same ternary — which is how the narrow tint would have shown up on a fresh layout
 * and vanished the moment the pointer crossed the floor.
 */
function baseColor(plank: Plank): THREE.Color {
  if (plank.narrow) return NARROW_PLANK_COLOR;
  if (plank.cut) return CUT_PLANK_COLOR;
  return plank.row % 2 === 0 ? PLANK_COLOR : PLANK_COLOR_ALT;
}

/** Drawn under the walls, over the grid. */
const Z_PLANK = -0.02;
const Z_SEAM = -0.015;

/** Seam width in feet — the visible joint between boards. */
const SEAM_FT = 0.02;

/**
 * Displace each vertex along the run by the end offset its corner carries.
 *
 * `step(0.0, position.x)` picks the right end of the 1x1 plane and `position.y + 0.5` is the
 * position across the board, so one `mix` of a `mix` covers all four corners. Applied to
 * `transformed` — after `begin_vertex` and before the instance matrix — so it is measured in the
 * geometry's own units, which is why the offsets are handed over pre-divided by the scale.
 */
const SHEAR_CHUNK = `
  float shearEnd = step(0.0, position.x);
  transformed.x += mix(
    mix(aShear.x, aShear.y, shearEnd),
    mix(aShear.z, aShear.w, shearEnd),
    position.y + 0.5
  );
`;

function applyShear(material: THREE.Material, cacheKey: string): void {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = `attribute vec4 aShear;\n${shader.vertexShader}`.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>\n${SHEAR_CHUNK}`
    );
  };
  // Three caches compiled programs by source; without a distinct key a patched material can be
  // handed a program compiled from the unpatched shader.
  material.customProgramCacheKey = () => cacheKey;
}

export class PlankRenderer {
  private readonly group: THREE.Group;
  private readonly geometry: THREE.PlaneGeometry;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly seamGeometry: THREE.PlaneGeometry;
  private readonly seamMaterial: THREE.MeshBasicMaterial;
  private mesh: THREE.InstancedMesh;
  private seams: THREE.InstancedMesh;
  private shear!: THREE.InstancedBufferAttribute;
  private seamShear!: THREE.InstancedBufferAttribute;
  private capacity = 0;

  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();

  private layout: PlankLayout | null = null;
  private hoveredId: string | null = null;
  private selectedId: string | null = null;
  /**
   * The board each instance belongs to.
   *
   * An instance is a segment, and a board whose end bends is more than one of them, so instance
   * index no longer equals plank index. This is what the hover path recolours through; keeping
   * it is cheaper than recomputing the mapping on every `mousemove`, and it is the only piece of
   * per-instance state the colour-only hover path needs.
   */
  private owner: Plank[] = [];

  constructor(parentScene: THREE.Scene) {
    this.group = new THREE.Group();
    parentScene.add(this.group);

    // A 1x1 plane scaled per instance: one geometry for every plank, whatever its length.
    this.geometry = new THREE.PlaneGeometry(1, 1);
    /**
     * **No `vertexColors`.** The per-plank tint arrives through `instanceColor`, and asking for
     * both silently renders the whole floor black.
     *
     * Three derives `USE_COLOR` from two different expressions. The vertex stage takes it from
     * `material.vertexColors` alone (`WebGLProgram.js:566`) and then runs `vColor *= color`; the
     * fragment stage takes it from `vertexColors || instancingColor` (`:735`). This geometry has
     * no `color` attribute — nothing here is a per-vertex colour — so with `vertexColors: true`
     * that multiply ran against a missing attribute, which WebGL supplies as `(0, 0, 0)`. The
     * following `vColor *= instanceColor` then multiplied into zero, so every plank drew black
     * and the floor's apparent colour was the seam quad's brown at 45% over it. Alternating rows,
     * the cut tint and the hover highlight were all being written and all being discarded.
     *
     * Dropping the flag leaves `USE_INSTANCING_COLOR` to open `vColor` at `vec3(1.0)`, and the
     * fragment stage still applies it because `instancingColor` is enough for its own define.
     */
    this.material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.9,
    });
    this.seamGeometry = new THREE.PlaneGeometry(1, 1);
    this.seamMaterial = new THREE.MeshBasicMaterial({
      color: 0x6b4f33,
      transparent: true,
      opacity: 0.45,
    });
    applyShear(this.material, 'plank-fill-shear');
    applyShear(this.seamMaterial, 'plank-seam-shear');

    this.mesh = this.allocate(0);
    this.seams = this.allocateSeams(0);
  }

  /**
   * The per-instance shear, `(bottomLeft, bottomRight, topLeft, topRight)`, on the geometry the
   * instances draw. Replaced rather than resized, since a `BufferAttribute`'s array is fixed.
   */
  private static shearAttribute(
    geometry: THREE.BufferGeometry,
    count: number
  ): THREE.InstancedBufferAttribute {
    const attribute = new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4);
    attribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aShear', attribute);
    return attribute;
  }

  private allocate(count: number): THREE.InstancedMesh {
    const size = Math.max(count, 1);
    this.shear = PlankRenderer.shearAttribute(this.geometry, size);
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, size);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(size * 3), 3);
    mesh.frustumCulled = false;
    mesh.count = 0;
    this.group.add(mesh);
    return mesh;
  }

  private allocateSeams(count: number): THREE.InstancedMesh {
    const size = Math.max(count, 1);
    this.seamShear = PlankRenderer.shearAttribute(this.seamGeometry, size);
    const mesh = new THREE.InstancedMesh(this.seamGeometry, this.seamMaterial, size);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    this.group.add(mesh);
    return mesh;
  }

  private ensureCapacity(count: number): void {
    if (count <= this.capacity && this.capacity > 0) return;
    this.group.remove(this.mesh);
    this.group.remove(this.seams);
    this.mesh.dispose();
    this.seams.dispose();
    // Grow with headroom so a floor that gains a row does not reallocate every frame.
    this.capacity = Math.max(64, Math.ceil(count * 1.25));
    this.mesh = this.allocate(this.capacity);
    this.seams = this.allocateSeams(this.capacity);
  }

  /** Write a layout into the instance buffers. Idempotent for the same layout reference. */
  update(layout: PlankLayout): void {
    this.layout = layout;
    const planks = layout.planks;
    // One instance per *segment*, not per plank. A board whose end bends has more than one, and
    // they are the same board — see `owner` for what that costs and `segmentsOf` for why.
    this.owner = planks.flatMap((plank) => {
      const count = plank.corners.length / 2 - 1;
      return Array.from({ length: count }, () => plank);
    });
    this.ensureCapacity(this.owner.length);

    this.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), layout.angle);
    const colors = this.mesh.instanceColor;
    const cos = Math.cos(layout.angle);
    const sin = Math.sin(layout.angle);

    let i = 0;
    for (const plank of planks) {
      const profile = plankProfile(plank);
      // The board's own frame: rotate out the shared run angle and measure from its nominal
      // centre. `along` is the run, `across` the width.
      const local = (p: { x: number; y: number }): { along: number; across: number } => {
        const dx = p.x - plank.center.x;
        const dy = p.y - plank.center.y;
        return { along: dx * cos + dy * sin, across: -dx * sin + dy * cos };
      };
      const points = profile.map(([start, end]) => ({ start: local(start), end: local(end) }));
      const half = plank.length / 2;

      for (let s = 0; s + 1 < points.length; s++) {
        const low = points[s];
        const high = points[s + 1];

        // Half a seam is taken off the board's *outer* boundary only. The joint between two
        // segments of one board is not a joint — leaving it inset would draw the seam this whole
        // change exists to remove, straight down the middle of a board that is not cut there.
        const lowInset = s === 0 ? SEAM_FT / 2 : 0;
        const highInset = s + 2 === points.length ? SEAM_FT / 2 : 0;
        const across = high.start.across - low.start.across;
        const fillY = Math.max(across - lowInset - highInset, 0.01);
        const centreAcross = (low.start.across + lowInset + (high.start.across - highInset)) / 2;

        // The fill's own ends, pulled half a seam inward from the board's. Reconstructing the
        // board's ends here instead would put the fill right back on the seam quad's edge and the
        // joint between two boards would vanish — the scale alone cannot inset them, because the
        // shear is what decides where an end actually lands.
        const inset = (start: number, end: number): [number, number] =>
          end - start <= SEAM_FT
            ? [(start + end) / 2, (start + end) / 2]
            : [start + SEAM_FT / 2, end - SEAM_FT / 2];
        const [fillLowStart, fillLowEnd] = inset(low.start.along, low.end.along);
        const [fillHighStart, fillHighEnd] = inset(high.start.along, high.end.along);

        const fillX = Math.max(plank.length - SEAM_FT, 0.01);
        const fillHalf = fillX / 2;
        this.setInstance(plank, centreAcross, cos, sin, Z_PLANK, fillX, fillY);
        this.mesh.setMatrixAt(i, this.matrix);
        this.shear.setXYZW(
          i,
          (fillLowStart + fillHalf) / fillX,
          (fillLowEnd - fillHalf) / fillX,
          (fillHighStart + fillHalf) / fillX,
          (fillHighEnd - fillHalf) / fillX
        );

        // Alternating row tint, a lighter cut piece and a red sliver: enough to read the stagger,
        // to see where the off-cuts land and to find an unusable rip, without a texture.
        const color = this.tint(plank);
        colors?.setXYZ(i, color.r, color.g, color.b);

        // The seam is the full-size quad behind the inset fill: one extra instance per segment,
        // still one draw call.
        const seamX = Math.max(plank.length, 0.01);
        this.setInstance(
          plank,
          (low.start.across + high.start.across) / 2,
          cos,
          sin,
          Z_SEAM,
          seamX,
          Math.max(across, 0.01)
        );
        this.seams.setMatrixAt(i, this.matrix);
        this.seamShear.setXYZW(
          i,
          (low.start.along + half) / seamX,
          (low.end.along - half) / seamX,
          (high.start.along + half) / seamX,
          (high.end.along - half) / seamX
        );
        i += 1;
      }
    }

    this.mesh.count = i;
    this.seams.count = i;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.seams.instanceMatrix.needsUpdate = true;
    this.shear.needsUpdate = true;
    this.seamShear.needsUpdate = true;
    if (colors) colors.needsUpdate = true;
  }

  /**
   * Compose one instance's matrix: the board's centre, pushed `across` along the width axis.
   *
   * The offset is what lets a segment sit where it belongs on a board without the shear having to
   * carry it — the shear displaces along the run only, so the across-run placement has to be in
   * the matrix. `(-sin, cos)` is the width axis, the run angle's normal.
   */
  private setInstance(
    plank: Plank,
    across: number,
    cos: number,
    sin: number,
    z: number,
    scaleX: number,
    scaleY: number
  ): void {
    this.position.set(plank.center.x - sin * across, plank.center.y + cos * across, z);
    this.scale.set(scaleX, scaleY, 1);
    this.matrix.compose(this.position, this.quaternion, this.scale);
  }

  /**
   * What one board draws at. The pick wins over the hover, so a picked board keeps its highlight
   * while the pointer wanders across the rest of the floor.
   */
  private tint(plank: Plank): THREE.Color {
    if (plank.id === this.selectedId) return SELECTED_COLOR;
    if (plank.id === this.hoveredId) return HOVER_COLOR;
    return baseColor(plank);
  }

  /**
   * Highlight one plank. Rewrites colours only — no matrices, no allocation — because this runs
   * on `mousemove` and the geometry has not changed.
   */
  setHovered(id: string | null): void {
    if (this.hoveredId === id) return;
    this.hoveredId = id;
    this.recolour();
  }

  /** The board being read out. Same colour-only path as the hover, for the same reason. */
  setSelected(id: string | null): void {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.recolour();
  }

  private recolour(): void {
    const colors = this.mesh.instanceColor;
    if (!this.layout || !colors) return;
    for (let i = 0; i < this.owner.length; i++) {
      const color = this.tint(this.owner[i]);
      colors.setXYZ(i, color.r, color.g, color.b);
    }
    colors.needsUpdate = true;
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  dispose(): void {
    this.mesh.dispose();
    this.seams.dispose();
    this.geometry.dispose();
    this.seamGeometry.dispose();
    this.material.dispose();
    this.seamMaterial.dispose();
    this.group.clear();
    // Unparent, or every mode switch leaves an empty group behind — the leak phase 4 found.
    this.group.parent?.remove(this.group);
  }
}
