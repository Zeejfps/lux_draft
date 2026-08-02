import * as THREE from 'three';
import type { Vector2 } from '../../../floorplan/types/geometry';
import { clearGroup } from '../../../floorplan/utils/three';

/**
 * The layout origin marker: a crosshair with a run-direction arm.
 *
 * It is one point, so it is drawn plainly. What matters is that it is the *same* point core's
 * entity seam hit-tests, drags and snaps — this renderer only draws where `FlooringData.origin`
 * already is, and the drag that moves it dispatches `flooring.origin.move` like any other
 * absolute move command.
 */

const ORIGIN_COLOR = 0x1d4ed8;
const ORIGIN_SELECTED_COLOR = 0xf59e0b;
const Z_ORIGIN = 0.12;
const ARM_FT = 1.2;
const DOT_RADIUS_FT = 0.16;

export class OriginMarkerRenderer {
  private readonly group: THREE.Group;

  constructor(parentScene: THREE.Scene) {
    this.group = new THREE.Group();
    parentScene.add(this.group);
  }

  update(origin: Vector2, runAngleDeg: number, selected: boolean): void {
    clearGroup(this.group);
    const color = selected ? ORIGIN_SELECTED_COLOR : ORIGIN_COLOR;
    const theta = (runAngleDeg * Math.PI) / 180;

    const material = new THREE.LineBasicMaterial({ color });
    const points = [
      new THREE.Vector3(origin.x - ARM_FT * 0.5, origin.y, Z_ORIGIN),
      new THREE.Vector3(origin.x + ARM_FT * 0.5, origin.y, Z_ORIGIN),
      new THREE.Vector3(origin.x, origin.y - ARM_FT * 0.5, Z_ORIGIN),
      new THREE.Vector3(origin.x, origin.y + ARM_FT * 0.5, Z_ORIGIN),
      // The run arm: which way the boards go, from the point they are measured from.
      new THREE.Vector3(origin.x, origin.y, Z_ORIGIN),
      new THREE.Vector3(
        origin.x + Math.cos(theta) * ARM_FT,
        origin.y + Math.sin(theta) * ARM_FT,
        Z_ORIGIN
      ),
    ];
    this.group.add(
      new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points), material)
    );

    const dot = new THREE.Mesh(
      new THREE.CircleGeometry(DOT_RADIUS_FT, 16),
      new THREE.MeshBasicMaterial({ color })
    );
    dot.position.set(origin.x, origin.y, Z_ORIGIN);
    this.group.add(dot);
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  dispose(): void {
    clearGroup(this.group);
    this.group.parent?.remove(this.group);
  }
}
