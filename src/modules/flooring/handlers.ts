import type { InputEvent } from '../../floorplan/core/InputManager';
import type { Door, Vector2, WallSegment } from '../../floorplan/types/geometry';
import type { InteractionContext } from '../../floorplan/types/interaction';
import { BaseInteractionHandler } from '../../floorplan/interactions/InteractionHandler';
import { getDoorEndpoints } from '../../floorplan/utils/geometry';
import type { Transition } from './types';
import type { Plank } from './PlankLayoutEngine';
import { DOOR_HIT_TOLERANCE_FT, FLOORING_TOOL_TRANSITION } from './constants';

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
