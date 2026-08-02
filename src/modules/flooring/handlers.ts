import type { InputEvent } from '../../floorplan/core/InputManager';
import type { Door, Vector2, WallSegment } from '../../floorplan/types/geometry';
import type { InteractionContext } from '../../floorplan/types/interaction';
import { BaseInteractionHandler } from '../../floorplan/interactions/InteractionHandler';
import { getDoorEndpoints } from '../../floorplan/utils/geometry';
import type { Divider, Transition } from './types';
import type { Plank } from './PlankLayoutEngine';
import { nearestOnSegment } from './geometry2d';
import {
  DOOR_HIT_TOLERANCE_FT,
  FLOORING_TOOL_DIVIDER,
  FLOORING_TOOL_TRANSITION,
} from './constants';

/**
 * Flooring's interaction handlers.
 *
 * Both are small, and both are small for the same reason: everything general — click-select,
 * shift-extend, box select, grab mode, snapping, measuring, Delete — already works on this
 * module's entity through the phase-4 seam, and none of it is written here.
 */

export interface TransitionHandlerConfig {
  getDoors(): readonly Door[];
  getWalls(): readonly WallSegment[];
  getTransitions(): readonly Transition[];
  addTransition(doorId: string): void;
  removeTransition(transitionId: string): void;
}

/**
 * The transition tool: click a doorway to trim it, click it again to untrim it.
 *
 * This handler is the "doors are already thresholds" claim as an interaction. It hit-tests
 * **core's** doors — no flooring geometry is involved and no flooring data is consulted except
 * the list of decisions already made.
 */
export class TransitionPlacementHandler extends BaseInteractionHandler {
  readonly name = 'flooringTransition';
  readonly priority = 90;

  private readonly config: TransitionHandlerConfig;

  constructor(config: TransitionHandlerConfig) {
    super();
    this.config = config;
  }

  canHandle(_event: InputEvent, context: InteractionContext): boolean {
    return context.activeTool === FLOORING_TOOL_TRANSITION;
  }

  handleClick(event: InputEvent, context: InteractionContext): boolean {
    if (!this.canHandle(event, context)) return false;

    const door = this.doorAt(event.worldPos);
    // Consume the click either way: the tool owns the pointer while it is selected, so a miss
    // must not fall through to core's selection handler and clear the selection.
    if (!door) return true;

    const existing = this.config.getTransitions().find((t) => t.doorId === door.id);
    if (existing) this.config.removeTransition(existing.id);
    else this.config.addTransition(door.id);
    return true;
  }

  private doorAt(position: Vector2): Door | null {
    const walls = new Map(this.config.getWalls().map((wall) => [wall.id, wall]));
    let best: Door | null = null;
    let bestDistance = DOOR_HIT_TOLERANCE_FT;

    for (const door of this.config.getDoors()) {
      const wall = walls.get(door.wallId);
      if (!wall) continue;
      const { start, end } = getDoorEndpoints(door, wall);
      const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
      const distance = Math.hypot(position.x - midpoint.x, position.y - midpoint.y);
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = door;
      }
    }
    return best;
  }
}

export interface DividerHandlerConfig {
  getWalls(): readonly WallSegment[];
  getDividers(): readonly Divider[];
  setPending(pending: { from: Vector2; to: Vector2 } | null): void;
  addDivider(a: Vector2, b: Vector2): void;
}

/**
 * The divider tool: click where the floor starts changing, click where it stops.
 *
 * Both clicks are **snapped onto the nearest boundary wall or existing divider**, with no
 * tolerance and no fallback to the raw position. That is not a nicety — `RegionSolver` splits a
 * face with a chord, and a chord that does not reach the face's edge splits nothing. Snapping
 * unconditionally means every divider this tool produces attaches; the `unattached` report
 * exists for the other case, a divider left dangling by a *later* wall edit.
 *
 * Snapping to an existing divider is what makes a T-junction drawable: a divider is an edge of
 * the two faces it created, so landing on one cuts the face on the side you are on.
 */
export class DividerPlacementHandler extends BaseInteractionHandler {
  readonly name = 'flooringDivider';
  readonly priority = 90;

  private readonly config: DividerHandlerConfig;
  private from: Vector2 | null = null;

  constructor(config: DividerHandlerConfig) {
    super();
    this.config = config;
  }

  canHandle(_event: InputEvent, context: InteractionContext): boolean {
    return context.activeTool === FLOORING_TOOL_DIVIDER;
  }

  handleClick(event: InputEvent, context: InteractionContext): boolean {
    if (!this.canHandle(event, context)) {
      this.abandon();
      return false;
    }
    const snapped = this.snap(event.worldPos);
    // Consume regardless: the tool owns the pointer while it is selected, so a miss must not
    // fall through to core's selection handler.
    if (!snapped) return true;

    if (!this.from) {
      this.from = snapped;
      this.config.setPending({ from: snapped, to: snapped });
      return true;
    }
    if (Math.hypot(snapped.x - this.from.x, snapped.y - this.from.y) > 1e-6) {
      this.config.addDivider(this.from, snapped);
    }
    this.reset();
    return true;
  }

  /** Observes only — returning false keeps the rubber band from swallowing anything else. */
  handleMouseMove(event: InputEvent, context: InteractionContext): boolean {
    if (!this.canHandle(event, context)) {
      this.abandon();
      return false;
    }
    if (!this.from) return false;
    this.config.setPending({ from: this.from, to: this.snap(event.worldPos) ?? event.worldPos });
    return false;
  }

  handleKeyDown(event: InputEvent, context: InteractionContext): boolean {
    if (!this.canHandle(event, context) || event.key !== 'Escape' || !this.from) return false;
    this.reset();
    return true;
  }

  private reset(): void {
    this.from = null;
    this.config.setPending(null);
  }

  /**
   * Drop a half-drawn line because the tool is no longer ours.
   *
   * Switching tools mid-draw is not a gesture anyone finishes later: the first point was placed
   * with this tool selected, and picking another one abandons it. Without this the rubber band
   * stays on the canvas — a line across the room with no obvious cause and no way to dismiss it,
   * since the only other exits are the second click and Escape, and neither reaches a handler
   * whose tool is inactive. Cheap to check: it only does anything when a point is actually held.
   */
  private abandon(): void {
    if (this.from) this.reset();
  }

  /** The nearest point on any boundary wall or existing divider. */
  private snap(position: Vector2): Vector2 | null {
    let best: Vector2 | null = null;
    let bestDistance = Infinity;

    const consider = (a: Vector2, b: Vector2): void => {
      const projection = nearestOnSegment(a, b, position);
      if (projection.distance < bestDistance) {
        bestDistance = projection.distance;
        best = projection.point;
      }
    };

    for (const wall of this.config.getWalls()) consider(wall.start, wall.end);
    for (const divider of this.config.getDividers()) consider(divider.a, divider.b);
    return best;
  }
}

export interface PlankHoverConfig {
  /** The plank under the cursor, from the spatial index, or null. */
  plankAt(position: Vector2): Plank | null;
  setHovered(plank: Plank | null): void;
}

/**
 * Read out the plank under the cursor.
 *
 * `handleMouseMove` always returns **false**: this handler observes, it does not consume. That
 * is what lets it sit at a high priority (so it sees the move before a drag operation swallows
 * it) without stopping any other handler from working.
 *
 * The lookup goes through `PlankIndex`, a uniform grid — a linear scan would touch every one of
 * several hundred planks at pointer rate, which is precisely the shape of stall this phase
 * exists to avoid.
 */
export class PlankHoverHandler extends BaseInteractionHandler {
  readonly name = 'flooringPlankHover';
  readonly priority = 5;

  private readonly config: PlankHoverConfig;

  constructor(config: PlankHoverConfig) {
    super();
    this.config = config;
  }

  canHandle(): boolean {
    return true;
  }

  handleMouseMove(event: InputEvent): boolean {
    this.config.setHovered(this.config.plankAt(event.worldPos));
    return false;
  }
}
