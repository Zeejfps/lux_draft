import type { Vector2, EditorCommand } from '../types';
import type {
  IDragOperation,
  DragStartContext,
  DragUpdateContext,
  AxisLock,
} from '../types/interaction';
import {
  calculateDelta as calcDelta,
  applyDelta as applyDeltaHelper,
} from './operations/grabModeHelpers';

/**
 * Abstract base class for drag operations.
 * Provides common functionality for all drag types.
 */
export abstract class BaseDragOperation implements IDragOperation {
  abstract readonly type: string;

  protected _isActive: boolean = false;
  protected startPosition: Vector2 | null = null;

  isActive(): boolean {
    return this._isActive;
  }

  /**
   * Get the start position for axis lock calculations.
   * This is the anchor item's original position, not the mouse click position.
   */
  getStartPosition(): Vector2 | null {
    return this.startPosition;
  }

  abstract start(context: DragStartContext): void;
  abstract update(context: DragUpdateContext): EditorCommand | null;

  /** End the operation. Writes nothing — a cancelled drag simply discards its preview. */
  finish(): void {
    this._isActive = false;
    this.cleanup();
  }

  /** Release per-drag state. Overridden by operations that capture origins. */
  protected cleanup(): void {}

  /**
   * Apply axis lock constraint to a position.
   */
  protected applyAxisConstraint(pos: Vector2, axisLock: AxisLock, origin: Vector2): Vector2 {
    if (axisLock === 'none' || !origin) return pos;

    if (axisLock === 'x') {
      return { x: pos.x, y: origin.y };
    } else if (axisLock === 'y') {
      return { x: origin.x, y: pos.y };
    }

    return pos;
  }

  /**
   * Calculate delta from start position to current position.
   */
  protected calculateDelta(from: Vector2, to: Vector2): Vector2 {
    return calcDelta(from, to);
  }

  /**
   * Apply a delta to a position.
   */
  protected applyDelta(position: Vector2, delta: Vector2): Vector2 {
    return applyDeltaHelper(position, delta);
  }
}
