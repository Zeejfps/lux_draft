import * as THREE from 'three';
import type { Door, Vector2, WallSegment } from '../../../floorplan/types/geometry';
import { getDoorEndpoints } from '../../../floorplan/utils/geometry';
import { clearGroup } from '../../../floorplan/utils/three';
import type { Transition } from '../types';

/**
 * Transitions, drawn straight onto the doors that define them.
 *
 * There is no transition geometry anywhere in this module: the strip below is built from the
 * `Door`'s wall, offset and width, which core already stores and already lets the user drag
 * along the wall. Moving a door moves its threshold, and nothing in flooring is told about it.
 * That is the "doors are already thresholds" claim, working.
 *
 * Counts are small — a room has a handful of doors — so this is an ordinary rebuild-on-change
 * renderer, unlike `PlankRenderer`.
 */

const TRANSITION_COLORS: Record<Transition['kind'], number> = {
  threshold: 0x8b5cf6,
  reducer: 0x0ea5e9,
  tMolding: 0x22c55e,
};

const CANDIDATE_COLOR = 0x94a3b8;
const Z_TRANSITION = 0.04;
const STRIP_DEPTH_FT = 0.35;

export class TransitionRenderer {
  private readonly group: THREE.Group;

  constructor(parentScene: THREE.Scene) {
    this.group = new THREE.Group();
    parentScene.add(this.group);
  }

  /**
   * @param candidates when true, every untrimmed door is outlined as a place a transition
   *   could go — the transition tool's affordance.
   */
  update(
    transitions: readonly Transition[],
    doors: readonly Door[],
    walls: readonly WallSegment[],
    candidates: boolean
  ): void {
    clearGroup(this.group);
    const byId = new Map(walls.map((wall) => [wall.id, wall]));
    const trimmed = new Map(transitions.map((t) => [t.doorId, t]));

    for (const door of doors) {
      const wall = byId.get(door.wallId);
      if (!wall) continue;
      const transition = trimmed.get(door.id);
      if (!transition && !candidates) continue;
      const { start, end } = getDoorEndpoints(door, wall);
      this.addStrip(
        start,
        end,
        transition ? TRANSITION_COLORS[transition.kind] : CANDIDATE_COLOR,
        transition ? 0.85 : 0.35
      );
    }
  }

  private addStrip(start: Vector2, end: Vector2, color: number, opacity: number): void {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (length <= 0) return;

    const geometry = new THREE.PlaneGeometry(length, STRIP_DEPTH_FT);
    const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set((start.x + end.x) / 2, (start.y + end.y) / 2, Z_TRANSITION);
    mesh.rotation.z = Math.atan2(dy, dx);
    this.group.add(mesh);
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  dispose(): void {
    clearGroup(this.group);
    this.group.parent?.remove(this.group);
  }
}
