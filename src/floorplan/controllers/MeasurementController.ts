import type { Vector2, WallSegment } from '../types';
import { projectPointOntoSegment } from '../utils/math';

export interface MeasurementData {
  from: Vector2;
  to: Vector2;
  deltaX: number;
  deltaY: number;
  distance: number;
}

/**
 * A measurement anchors on a room vertex or on one of the active module's entities. The
 * `entity` variant used to be `light`; core names no domain.
 */
export type MeasurementSource = { type: 'vertex'; index: number } | { type: 'entity'; id: string };

export type MeasurementTarget =
  | { type: 'vertex'; index: number }
  | { type: 'entity'; id: string }
  | { type: 'wall'; id: string }
  | null;

/**
 * Manages measurement state and calculations.
 * Supports measuring between vertices, module entities, and to walls.
 */
export class MeasurementController {
  private _isActive = false;
  private _fromPosition: Vector2 | null = null;
  private _toPosition: Vector2 | null = null;
  private _source: MeasurementSource | null = null;
  private _target: MeasurementTarget = null;

  get isActive(): boolean {
    return this._isActive;
  }

  get fromPosition(): Vector2 | null {
    return this._fromPosition;
  }

  get toPosition(): Vector2 | null {
    return this._toPosition;
  }

  get source(): MeasurementSource | null {
    return this._source;
  }

  get target(): MeasurementTarget {
    return this._target;
  }

  get isFromEntity(): boolean {
    return this._source?.type === 'entity';
  }

  get sourceEntityId(): string | null {
    return this._source?.type === 'entity' ? this._source.id : null;
  }

  get sourceVertexIndex(): number | null {
    return this._source?.type === 'vertex' ? this._source.index : null;
  }

  /**
   * Starts a measurement from a vertex.
   */
  startFromVertex(index: number, position: Vector2): void {
    this._isActive = true;
    this._source = { type: 'vertex', index };
    this._fromPosition = { ...position };
    this._toPosition = null;
    this._target = null;
  }

  /**
   * Starts a measurement from a module entity.
   */
  startFromEntity(entityId: string, position: Vector2): void {
    this._isActive = true;
    this._source = { type: 'entity', id: entityId };
    this._fromPosition = { ...position };
    this._toPosition = null;
    this._target = null;
  }

  /**
   * Sets the measurement target to a vertex.
   */
  setTargetVertex(index: number, position: Vector2): void {
    this._target = { type: 'vertex', index };
    this._toPosition = { ...position };
  }

  /**
   * Sets the measurement target to a module entity.
   */
  setTargetEntity(entityId: string, position: Vector2): void {
    this._target = { type: 'entity', id: entityId };
    this._toPosition = { ...position };
  }

  /**
   * Sets the measurement target to a wall (perpendicular distance).
   */
  setTargetWall(wallId: string, wall: WallSegment): void {
    if (!this._fromPosition) return;

    this._target = { type: 'wall', id: wallId };
    this._toPosition = projectPointOntoSegment(this._fromPosition, wall.start, wall.end);
  }

  /**
   * Updates the source position (e.g., when dragging the source entity/vertex).
   */
  updateSourcePosition(position: Vector2, walls?: WallSegment[]): void {
    this._fromPosition = { ...position };

    // If measuring to a wall, recalculate projection
    const target = this._target;
    if (target?.type === 'wall' && walls) {
      const wall = walls.find((w) => w.id === target.id);
      if (wall) {
        this._toPosition = projectPointOntoSegment(this._fromPosition, wall.start, wall.end);
      }
    }
  }

  /**
   * Updates the target position (e.g., when dragging the target entity/vertex).
   */
  updateTargetPosition(position: Vector2): void {
    this._toPosition = { ...position };
  }

  /**
   * Clears the measurement and resets state.
   */
  clear(): void {
    this._isActive = false;
    this._fromPosition = null;
    this._toPosition = null;
    this._source = null;
    this._target = null;
  }

  /**
   * Calculates and returns the current measurement data.
   * Returns null if measurement is incomplete.
   */
  getMeasurementData(): MeasurementData | null {
    if (!this._fromPosition || !this._toPosition) return null;

    const deltaX = this._toPosition.x - this._fromPosition.x;
    const deltaY = this._toPosition.y - this._fromPosition.y;
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

    return {
      from: { ...this._fromPosition },
      to: { ...this._toPosition },
      deltaX,
      deltaY,
      distance,
    };
  }
}
