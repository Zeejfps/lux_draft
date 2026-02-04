import type { InputEvent } from '../../core/InputManager';
import type { Door, DoorSwingDirection, DoorSwingSide, WallSegment, Vector2 } from '../../types';
import type { InteractionContext } from '../../types/interaction';
import { BaseInteractionHandler } from '../InteractionHandler';
import { generateId } from '../../utils/id';
import { vectorSubtract, vectorDot, vectorLength } from '../../utils/math';

export interface DoorPlacementHandlerCallbacks {
  onDoorPlaced: (door: Door) => void;
  onDoorPreview: (door: Door | null, wall: WallSegment | null) => void;
}

export interface DoorPlacementHandlerConfig {
  getWalls: () => WallSegment[];
  getDoors: () => Door[];
  getWallAtPosition: (pos: Vector2, walls: WallSegment[], tolerance: number) => WallSegment | null;
  getSelectedDoorWidth: () => number;
  getSelectedDoorSwingDirection: () => DoorSwingDirection;
  getSelectedDoorSwingSide: () => DoorSwingSide;
  canPlaceDoors: () => boolean;
}

// Standard door widths in feet
export const DOOR_WIDTHS = {
  '2\'6"': 2.5,
  '2\'8"': 2.67,
  '3\'0"': 3.0,
  '3\'6"': 3.5,
} as const;

export const DEFAULT_DOOR_WIDTH = DOOR_WIDTHS['3\'0"'];
export const DOOR_PLACEMENT_TOLERANCE = 0.5; // feet

/**
 * Projects a point onto a wall and returns the distance from the wall's start.
 */
function projectPointOntoWall(point: Vector2, wall: WallSegment): number {
  const wallDir = vectorSubtract(wall.end, wall.start);
  const wallLength = vectorLength(wallDir);
  if (wallLength === 0) return 0;

  const normalizedDir = { x: wallDir.x / wallLength, y: wallDir.y / wallLength };
  const toPoint = vectorSubtract(point, wall.start);
  const projection = vectorDot(toPoint, normalizedDir);

  // Clamp to wall bounds
  return Math.max(0, Math.min(wallLength, projection));
}

/**
 * Checks if a door can be placed at the given position on a wall.
 * Returns false if the door would extend past the wall ends or overlap existing doors.
 */
function canPlaceDoorAtPosition(
  wall: WallSegment,
  position: number,
  width: number,
  existingDoors: Door[]
): boolean {
  const halfWidth = width / 2;

  // Check wall bounds (leave some margin from wall ends)
  const margin = 0.25; // 3 inches from corners
  if (position - halfWidth < margin || position + halfWidth > wall.length - margin) {
    return false;
  }

  // Check for overlap with existing doors on same wall
  const doorsOnWall = existingDoors.filter(d => d.wallId === wall.id);
  for (const door of doorsOnWall) {
    const doorHalfWidth = door.width / 2;
    const doorStart = door.position - doorHalfWidth;
    const doorEnd = door.position + doorHalfWidth;
    const newDoorStart = position - halfWidth;
    const newDoorEnd = position + halfWidth;

    // Check for overlap (with small gap requirement)
    const gap = 0.1; // Small gap between doors
    if (!(newDoorEnd + gap < doorStart || newDoorStart - gap > doorEnd)) {
      return false;
    }
  }

  return true;
}

/**
 * Handles door placement mode.
 * Places doors on walls at clicked positions.
 */
export class DoorPlacementHandler extends BaseInteractionHandler {
  readonly name = 'doorPlacement';
  readonly priority = 85;

  private config: DoorPlacementHandlerConfig;
  private callbacks: DoorPlacementHandlerCallbacks;

  constructor(config: DoorPlacementHandlerConfig, callbacks: DoorPlacementHandlerCallbacks) {
    super();
    this.config = config;
    this.callbacks = callbacks;
  }

  canHandle(_event: InputEvent, context: InteractionContext): boolean {
    return context.isPlacingDoors && this.config.canPlaceDoors();
  }

  handleClick(event: InputEvent, context: InteractionContext): boolean {
    if (!context.isPlacingDoors || !this.config.canPlaceDoors()) {
      return false;
    }

    const walls = this.config.getWalls();
    const pos = event.worldPos;

    // Find wall at click position
    const wall = this.config.getWallAtPosition(pos, walls, DOOR_PLACEMENT_TOLERANCE);
    if (!wall) {
      return true; // Consumed the event but didn't place
    }

    // Project click point onto wall to get position along wall
    const positionOnWall = projectPointOntoWall(pos, wall);

    // Get selected door settings
    const doorWidth = this.config.getSelectedDoorWidth();
    const swingDirection = this.config.getSelectedDoorSwingDirection();
    const swingSide = this.config.getSelectedDoorSwingSide();

    // Validate door fits
    const existingDoors = this.config.getDoors();
    if (!canPlaceDoorAtPosition(wall, positionOnWall, doorWidth, existingDoors)) {
      return true; // Consumed the event but couldn't place
    }

    // Create door with selected settings
    const newDoor: Door = {
      id: generateId(),
      wallId: wall.id,
      position: positionOnWall,
      width: doorWidth,
      swingDirection,
      swingSide,
    };

    // Clear preview before placing
    this.callbacks.onDoorPreview(null, null);
    this.callbacks.onDoorPlaced(newDoor);
    return true;
  }

  handleMouseMove(event: InputEvent, context: InteractionContext): boolean {
    if (!context.isPlacingDoors || !this.config.canPlaceDoors()) {
      this.callbacks.onDoorPreview(null, null);
      return false;
    }

    const walls = this.config.getWalls();
    const pos = event.worldPos;

    // Find wall at mouse position
    const wall = this.config.getWallAtPosition(pos, walls, DOOR_PLACEMENT_TOLERANCE);
    if (!wall) {
      this.callbacks.onDoorPreview(null, null);
      return false;
    }

    // Project mouse point onto wall to get position along wall
    const positionOnWall = projectPointOntoWall(pos, wall);

    // Get selected door settings
    const doorWidth = this.config.getSelectedDoorWidth();
    const swingDirection = this.config.getSelectedDoorSwingDirection();
    const swingSide = this.config.getSelectedDoorSwingSide();

    // Check if door can be placed here
    const existingDoors = this.config.getDoors();
    if (!canPlaceDoorAtPosition(wall, positionOnWall, doorWidth, existingDoors)) {
      this.callbacks.onDoorPreview(null, null);
      return false;
    }

    // Create preview door (without id since it's not placed yet)
    const previewDoor: Door = {
      id: 'preview',
      wallId: wall.id,
      position: positionOnWall,
      width: doorWidth,
      swingDirection,
      swingSide,
    };

    this.callbacks.onDoorPreview(previewDoor, wall);
    return false; // Don't consume the event, let other handlers process if needed
  }
}
