import * as THREE from 'three';

/**
 * Disposes of a Three.js Object3D's geometry and material resources.
 */
export function disposeObject3D(object: THREE.Object3D): void {
  if (
    object instanceof THREE.Mesh ||
    object instanceof THREE.Line ||
    object instanceof THREE.LineSegments
  ) {
    object.geometry.dispose();
    if (Array.isArray(object.material)) {
      object.material.forEach((m) => m.dispose());
    } else {
      (object.material as THREE.Material).dispose();
    }
  } else if (object instanceof THREE.Sprite) {
    object.material.map?.dispose();
    object.material.dispose();
  }
}

/**
 * Removes all children from a group and disposes their resources.
 */
export function clearGroup(group: THREE.Group): void {
  while (group.children.length > 0) {
    const child = group.children[0];
    group.remove(child);
    disposeObject3D(child);
  }
}

/**
 * Disposes of all meshes in an array and clears the array.
 */
export function disposeMeshArray(meshes: THREE.Mesh[], scene?: THREE.Scene): void {
  for (const mesh of meshes) {
    if (scene) {
      scene.remove(mesh);
    }
    mesh.geometry.dispose();
    if (Array.isArray(mesh.material)) {
      mesh.material.forEach((m) => m.dispose());
    } else {
      (mesh.material as THREE.Material).dispose();
    }
  }
  meshes.length = 0;
}

/**
 * Creates uniform arrays for shader materials with MAX_LIGHTS capacity.
 */
export function createLightUniformArrays(maxLights: number): {
  positions: THREE.Vector2[];
  lumens: number[];
  beamAngles: number[];
} {
  const positions: THREE.Vector2[] = [];
  const lumens: number[] = [];
  const beamAngles: number[] = [];

  for (let i = 0; i < maxLights; i++) {
    positions.push(new THREE.Vector2(0, 0));
    lumens.push(0);
    beamAngles.push(60);
  }

  return { positions, lumens, beamAngles };
}

const MAX_DASHES = 10000;

function polylineLength(points: { x: number; y: number }[]): number {
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
  }
  return total;
}

export interface ThickLineOptions {
  color: number;
  /** Line width in world units (feet). */
  width: number;
  z?: number;
  /** Omit for a solid line. Dashes run continuously across polyline joins. */
  dash?: { dashSize: number; gapSize: number };
  opacity?: number;
}

/**
 * Builds a polyline as a ribbon of quads.
 *
 * `THREE.LineBasicMaterial.linewidth` is ignored by the WebGL renderer — every
 * `THREE.Line` comes out one pixel wide no matter what — so anything that needs to be
 * visibly thicker has to be actual geometry. Width is in world units, which means the
 * line scales with zoom the same way the text sprites and marker circles do.
 *
 * Segments are emitted as independent quads with no mitring at the joins. That leaves a
 * hairline notch on the outside of a sharp corner, which is invisible at these widths on
 * the shallow joins of a subdivided arc, but makes this the wrong tool for a thick
 * polyline with hard corners.
 */
export function createThickLine(
  points: { x: number; y: number }[],
  options: ThickLineOptions
): THREE.Mesh {
  const { color, width, z = 0, dash, opacity = 1 } = options;
  const half = width / 2;
  const positions: number[] = [];
  const indices: number[] = [];

  const addQuad = (ax: number, ay: number, bx: number, by: number): void => {
    const dx = bx - ax;
    const dy = by - ay;
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) return;

    const nx = (-dy / length) * half;
    const ny = (dx / length) * half;
    const base = positions.length / 3;

    positions.push(
      ax + nx,
      ay + ny,
      z,
      ax - nx,
      ay - ny,
      z,
      bx - nx,
      by - ny,
      z,
      bx + nx,
      by + ny,
      z
    );
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  const period = dash ? dash.dashSize + dash.gapSize : 0;
  const totalLength = polylineLength(points);
  // A period small enough to dash a long line into tens of thousands of quads is a
  // caller mistake; draw it solid rather than building geometry that stalls the frame.
  const dashed =
    dash !== undefined && dash.dashSize > 0 && period > 0 && totalLength / period <= MAX_DASHES;
  let phase = 0;

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];

    if (!dashed) {
      addQuad(a.x, a.y, b.x, b.y);
      continue;
    }

    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 1e-9) continue;

    const at = (t: number) => ({
      x: a.x + ((b.x - a.x) * t) / length,
      y: a.y + ((b.y - a.y) * t) / length,
    });

    // Index the dashes off the running arc length rather than stepping a cursor along
    // the segment. Stepping accumulates rounding error, and once a step lands a hair
    // short of a period boundary the next dash is ~1e-16 long — too small to move a
    // float, so the walk stops advancing and spins forever.
    const segmentStart = phase;
    const segmentEnd = phase + length;
    const firstDash = Math.floor(segmentStart / period);
    const lastDash = Math.floor(segmentEnd / period);

    for (let d = firstDash; d <= lastDash; d++) {
      const dashStart = Math.max(segmentStart, d * period);
      const dashEnd = Math.min(segmentEnd, d * period + dash!.dashSize);
      if (dashEnd <= dashStart) continue;

      const start = at(dashStart - segmentStart);
      const end = at(dashEnd - segmentStart);
      addQuad(start.x, start.y, end.x, end.y);
    }

    phase = segmentEnd % period;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);

  const material = new THREE.MeshBasicMaterial({
    color,
    side: THREE.DoubleSide,
    transparent: opacity < 1,
    opacity,
  });

  return new THREE.Mesh(geometry, material);
}

export interface TextSpriteOptions {
  fontSize?: number;
  padding?: number;
  fontWeight?: 'normal' | 'bold';
  backgroundColor?: string | number;
  textColor?: string;
  scale?: number;
}

/**
 * Creates a text sprite using canvas rendering.
 * Used for dimension labels, measurement labels, etc.
 */
export function createTextSprite(text: string, options: TextSpriteOptions = {}): THREE.Sprite {
  const {
    fontSize = 24,
    padding = 12,
    fontWeight = 'normal',
    backgroundColor = 'white',
    textColor = 'black',
    scale = 0.5,
  } = options;

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d')!;

  const font = `${fontWeight === 'bold' ? 'bold ' : ''}${fontSize}px Arial`;
  context.font = font;
  const textWidth = context.measureText(text).width;

  canvas.width = Math.ceil(textWidth + padding * 2);
  canvas.height = fontSize + padding;

  // Draw background
  const bgColor =
    typeof backgroundColor === 'number'
      ? `#${backgroundColor.toString(16).padStart(6, '0')}`
      : backgroundColor;
  context.fillStyle = bgColor;
  context.fillRect(0, 0, canvas.width, canvas.height);

  // Draw text
  context.font = font;
  context.fillStyle = textColor;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture });
  const sprite = new THREE.Sprite(material);

  const aspectRatio = canvas.width / canvas.height;
  sprite.scale.set(aspectRatio * scale, scale, 1);

  return sprite;
}
