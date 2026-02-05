import * as THREE from 'three';
import type { WallSegment } from '../types';
import { createLightUniformArrays } from '../utils/three';
import { BaseLightingRenderer } from './BaseLightingRenderer';

import heatmapVertexShader from './shaders/heatmap.vert?raw';
import heatmapFragmentShader from './shaders/heatmap.frag?raw';

const MAX_LIGHTS = 32;
const MAX_POLYGON_VERTICES = 64;

export class HeatmapRenderer extends BaseLightingRenderer {
  protected zPosition = -0.05;

  constructor(scene: THREE.Scene) {
    const { positions, lumens, beamAngles } = createLightUniformArrays(MAX_LIGHTS);

    // Create polygon vertex array for wall clipping
    const polygonVertices: THREE.Vector2[] = [];
    for (let i = 0; i < MAX_POLYGON_VERTICES; i++) {
      polygonVertices.push(new THREE.Vector2(0, 0));
    }

    const material = new THREE.ShaderMaterial({
      vertexShader: heatmapVertexShader,
      fragmentShader: heatmapFragmentShader,
      transparent: true,
      uniforms: {
        uLightCount: { value: 0 },
        uLightPositions: { value: positions },
        uLightLumens: { value: lumens },
        uLightBeamAngles: { value: beamAngles },
        uCeilingHeight: { value: 8.0 },
        uVertexCount: { value: 0 },
        uPolygonVertices: { value: polygonVertices },
      },
    });

    super(scene, material);
  }

  updateWalls(walls: WallSegment[]): void {
    const count = Math.min(walls.length, MAX_POLYGON_VERTICES);

    // Extract vertices from wall segments (each wall's start point)
    for (let i = 0; i < MAX_POLYGON_VERTICES; i++) {
      if (i < count) {
        this.material.uniforms.uPolygonVertices.value[i].set(
          walls[i].start.x,
          walls[i].start.y
        );
      } else {
        this.material.uniforms.uPolygonVertices.value[i].set(0, 0);
      }
    }

    this.material.uniforms.uVertexCount.value = count;
    this.material.uniformsNeedUpdate = true;
  }
}
