import * as THREE from 'three';
import type { Door, Vector2, WallSegment } from '../../../floorplan/types/geometry';
import { getDoorEndpoints } from '../../../floorplan/utils/geometry';
import { clearGroup } from '../../../floorplan/utils/three';
import type { TransitionSegment } from '../RegionSolver';
import type { Divider, Transition } from '../types';

/**
 * Transitions, from both places a floor can change.
 *
 * **At a doorway** there is no transition geometry anywhere in this module: the strip is built
 * from the `Door`'s wall, offset and width, which core already stores and already lets the user
 * drag along the wall. Moving a door moves its threshold, and nothing in flooring is told about
 * it. That is the "doors are already thresholds" claim, working.
 *
 * **Mid-room** there is still no stored geometry — a `TransitionSegment` is derived by
 * `RegionSolver` from the divider the user drew and the surfaces either side of it. A divider
 * with the same floor on both sides produces no segment and is drawn only as a faint guide, so
 * the strips on screen are exactly the trim that would actually be bought.
 *
 * Counts are small — a room has a handful of doors and fewer dividers — so this is an ordinary
 * rebuild-on-change renderer, unlike `PlankRenderer`.
 */

const TRANSITION_COLORS: Record<Transition['kind'], number> = {
  threshold: 0x8b5cf6,
  reducer: 0x0ea5e9,
  tMolding: 0x22c55e,
};

const CANDIDATE_COLOR = 0x94a3b8;
/** A divider the solver could not attach to any area: authored, inert, and worth seeing. */
const UNATTACHED_COLOR = 0xef4444;
const PENDING_COLOR = 0x38bdf8;
const Z_TRANSITION = 0.04;
const STRIP_DEPTH_FT = 0.35;
const GUIDE_DEPTH_FT = 0.06;

export class TransitionRenderer {
  /** Doors and dividers rebuild on different inputs, so each owns its own group. */
  private readonly doorGroup: THREE.Group;
  private readonly dividerGroup: THREE.Group;
  private readonly group: THREE.Group;

  constructor(parentScene: THREE.Scene) {
    this.group = new THREE.Group();
    this.doorGroup = new THREE.Group();
    this.dividerGroup = new THREE.Group();
    this.group.add(this.doorGroup);
    this.group.add(this.dividerGroup);
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
    clearGroup(this.doorGroup);
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
        transition ? 0.85 : 0.35,
        STRIP_DEPTH_FT,
        this.doorGroup
      );
    }
  }

  /**
   * The mid-room half: derived strips where the floor actually changes, a faint guide along
   * every divider the user drew, and the rubber band of one being drawn.
   */
  updateDividers(
    segments: readonly TransitionSegment[],
    dividers: readonly Divider[],
    unattached: readonly string[],
    pending: { from: Vector2; to: Vector2 } | null,
    guides: boolean
  ): void {
    clearGroup(this.dividerGroup);
    const orphaned = new Set(unattached);

    for (const divider of dividers) {
      const orphan = orphaned.has(divider.id);
      // A divider with the same floor either side produces no trim, so outside the divider tool
      // it draws nothing: a line across the room that changes neither the floor nor the cut
      // list reads as a rendering fault, not as data. It is still listed in the panel, and the
      // tool brings every line back the moment you go looking for one — the same bargain the
      // door candidates above make. An **unattached** divider is different: that is an error,
      // and an error stays on screen until it is dealt with.
      if (!orphan && !guides) continue;
      this.addStrip(
        divider.a,
        divider.b,
        orphan ? UNATTACHED_COLOR : CANDIDATE_COLOR,
        orphan ? 0.9 : 0.5,
        GUIDE_DEPTH_FT,
        this.dividerGroup
      );
    }

    for (const segment of segments) {
      this.addStrip(
        segment.start,
        segment.end,
        TRANSITION_COLORS[segment.kind],
        0.85,
        STRIP_DEPTH_FT,
        this.dividerGroup
      );
    }

    if (pending) {
      this.addStrip(
        pending.from,
        pending.to,
        PENDING_COLOR,
        0.7,
        GUIDE_DEPTH_FT,
        this.dividerGroup
      );
    }
  }

  private addStrip(
    start: Vector2,
    end: Vector2,
    color: number,
    opacity: number,
    depth: number,
    target: THREE.Group
  ): void {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (length <= 0) return;

    const geometry = new THREE.PlaneGeometry(length, depth);
    const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set((start.x + end.x) / 2, (start.y + end.y) / 2, Z_TRANSITION);
    mesh.rotation.z = Math.atan2(dy, dx);
    target.add(mesh);
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  dispose(): void {
    clearGroup(this.doorGroup);
    clearGroup(this.dividerGroup);
    this.group.parent?.remove(this.group);
  }
}
