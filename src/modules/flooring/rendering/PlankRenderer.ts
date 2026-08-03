import * as THREE from 'three';
import type { PlankLayout } from '../PlankLayoutEngine';

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
 */

const PLANK_COLOR = new THREE.Color(0xb98a56);
const PLANK_COLOR_ALT = new THREE.Color(0xa97c4c);
const CUT_PLANK_COLOR = new THREE.Color(0xc99a63);
const HOVER_COLOR = new THREE.Color(0x38bdf8);

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

  constructor(parentScene: THREE.Scene) {
    this.group = new THREE.Group();
    parentScene.add(this.group);

    // A 1x1 plane scaled per instance: one geometry for every plank, whatever its length.
    this.geometry = new THREE.PlaneGeometry(1, 1);
    this.material = new THREE.MeshBasicMaterial({
      vertexColors: true,
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
    this.ensureCapacity(planks.length);

    this.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), layout.angle);
    const colors = this.mesh.instanceColor;
    const cos = Math.cos(layout.angle);
    const sin = Math.sin(layout.angle);

    for (let i = 0; i < planks.length; i++) {
      const plank = planks[i];

      // The corners in the instance's own frame: rotate out the shared run angle, then measure
      // from the nominal rectangle's ends. Which side of the board a corner is on is read off
      // its own coordinates rather than off its index, because a mirrored start corner reverses
      // the winding — and two corners of the four sit on each side by construction, since the
      // engine's ends are the two edges of a band.
      let bottomLeft = Infinity;
      let bottomRight = -Infinity;
      let topLeft = Infinity;
      let topRight = -Infinity;
      for (const corner of plank.corners) {
        const dx = corner.x - plank.center.x;
        const dy = corner.y - plank.center.y;
        const along = dx * cos + dy * sin;
        if (-dx * sin + dy * cos < 0) {
          bottomLeft = Math.min(bottomLeft, along);
          bottomRight = Math.max(bottomRight, along);
        } else {
          topLeft = Math.min(topLeft, along);
          topRight = Math.max(topRight, along);
        }
      }
      const half = plank.length / 2;

      // The fill's own ends, pulled half a seam inward from the board's. Reconstructing the
      // board's ends here instead would put the fill right back on the seam quad's edge and the
      // joint between two boards would vanish — the scale alone cannot inset them, because the
      // shear is what decides where an end actually lands.
      const inset = (low: number, high: number): [number, number] =>
        high - low <= SEAM_FT
          ? [(low + high) / 2, (low + high) / 2]
          : [low + SEAM_FT / 2, high - SEAM_FT / 2];
      const [fillBottomLeft, fillBottomRight] = inset(bottomLeft, bottomRight);
      const [fillTopLeft, fillTopRight] = inset(topLeft, topRight);

      const fillX = Math.max(plank.length - SEAM_FT, 0.01);
      const fillHalf = fillX / 2;
      this.position.set(plank.center.x, plank.center.y, Z_PLANK);
      this.scale.set(fillX, Math.max(plank.width - SEAM_FT, 0.01), 1);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.mesh.setMatrixAt(i, this.matrix);
      this.shear.setXYZW(
        i,
        (fillBottomLeft + fillHalf) / fillX,
        (fillBottomRight - fillHalf) / fillX,
        (fillTopLeft + fillHalf) / fillX,
        (fillTopRight - fillHalf) / fillX
      );

      // Alternating row tint plus a lighter cut piece: enough to read the stagger and to see
      // at a glance where the off-cuts land, without a texture.
      const base = plank.cut
        ? CUT_PLANK_COLOR
        : plank.row % 2 === 0
          ? PLANK_COLOR
          : PLANK_COLOR_ALT;
      const color = plank.id === this.hoveredId ? HOVER_COLOR : base;
      colors?.setXYZ(i, color.r, color.g, color.b);

      // The seam is the full-size quad behind the inset fill: one extra instance per plank,
      // still one draw call.
      const seamX = Math.max(plank.length, 0.01);
      this.position.set(plank.center.x, plank.center.y, Z_SEAM);
      this.scale.set(seamX, plank.width, 1);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.seams.setMatrixAt(i, this.matrix);
      this.seamShear.setXYZW(
        i,
        (bottomLeft + half) / seamX,
        (bottomRight - half) / seamX,
        (topLeft + half) / seamX,
        (topRight - half) / seamX
      );
    }

    this.mesh.count = planks.length;
    this.seams.count = planks.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.seams.instanceMatrix.needsUpdate = true;
    this.shear.needsUpdate = true;
    this.seamShear.needsUpdate = true;
    if (colors) colors.needsUpdate = true;
  }

  /**
   * Highlight one plank. Rewrites colours only — no matrices, no allocation — because this runs
   * on `mousemove` and the geometry has not changed.
   */
  setHovered(id: string | null): void {
    if (this.hoveredId === id) return;
    this.hoveredId = id;
    const colors = this.mesh.instanceColor;
    if (!this.layout || !colors) return;
    const planks = this.layout.planks;
    for (let i = 0; i < planks.length; i++) {
      const plank = planks[i];
      const base = plank.cut
        ? CUT_PLANK_COLOR
        : plank.row % 2 === 0
          ? PLANK_COLOR
          : PLANK_COLOR_ALT;
      const color = plank.id === id ? HOVER_COLOR : base;
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
