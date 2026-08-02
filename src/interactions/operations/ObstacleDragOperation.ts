import type { Vector2, EditorCommand } from '../../types';
import type { DragStartContext, DragUpdateContext } from '../../types/interaction';
import type { SnapController } from '../../controllers/SnapController';
import type { DragOperationCallbacks } from '../DragManager';
import { BaseDragOperation } from '../DragOperation';

export interface ObstacleDragConfig {
  snapController: SnapController;
  getGridSnapEnabled: () => boolean;
  getGridSize: () => number;
  getRoomVertices: () => Vector2[];
}

/**
 * Handles dragging an entire obstacle (moves all vertices together).
 * Supports grid snapping and shift-alignment to room vertices.
 */
export class ObstacleDragOperation extends BaseDragOperation {
  readonly type = 'obstacle';

  private obstacleId: string | null = null;
  private originalVertexPositions: Map<number, Vector2> = new Map();
  private config: ObstacleDragConfig;
  private callbacks: DragOperationCallbacks;

  constructor(config: ObstacleDragConfig, callbacks: DragOperationCallbacks) {
    super();
    this.config = config;
    this.callbacks = callbacks;
  }

  setObstacleId(obstacleId: string): void {
    this.obstacleId = obstacleId;
  }

  /**
   * Provide all obstacle vertex positions to store originals.
   */
  setObstacleVertices(vertices: Vector2[]): void {
    this.originalVertexPositions.clear();
    for (let i = 0; i < vertices.length; i++) {
      this.originalVertexPositions.set(i, { ...vertices[i] });
    }
  }

  start(context: DragStartContext): void {
    if (!this.obstacleId || this.originalVertexPositions.size === 0) return;

    this._isActive = true;
    this.startPosition = { ...context.position };
  }

  update(context: DragUpdateContext): EditorCommand | null {
    if (!this._isActive || !this.obstacleId || !this.startPosition) return null;

    let constrainedPos = context.position;

    // Apply axis lock
    if (context.axisLock !== 'none') {
      constrainedPos = this.applyAxisConstraint(
        context.position,
        context.axisLock,
        this.startPosition
      );
    }

    // Apply grid snapping
    if (this.config.getGridSnapEnabled()) {
      const gridSize = this.config.getGridSize();
      if (gridSize > 0) {
        constrainedPos = this.config.snapController.snapToGrid(constrainedPos, gridSize);
      }
    }

    // Shift-held: snap obstacle vertices to room vertices
    if (context.modifiers.shiftKey) {
      const delta = this.calculateDelta(this.startPosition, constrainedPos);
      const roomVertices = this.config.getRoomVertices();
      const snapResult = this.snapObstacleToRoomVertices(delta, roomVertices);
      constrainedPos = {
        x: this.startPosition.x + snapResult.delta.x,
        y: this.startPosition.y + snapResult.delta.y,
      };
      if (snapResult.guides.length > 0) {
        this.callbacks.onSetSnapGuides(snapResult.guides);
      } else {
        this.callbacks.onSetSnapGuides([]);
      }
    } else if (context.axisLock === 'none') {
      this.callbacks.onSetSnapGuides([]);
    }

    const delta = this.calculateDelta(this.startPosition, constrainedPos);

    // Absolute target for every vertex, in index order
    const vertices: Vector2[] = [];
    for (let i = 0; i < this.originalVertexPositions.size; i++) {
      const originalPos = this.originalVertexPositions.get(i);
      if (!originalPos) return null;
      vertices.push({ x: originalPos.x + delta.x, y: originalPos.y + delta.y });
    }

    return { type: 'obstacle.move', obstacleId: this.obstacleId, vertices };
  }

  private snapObstacleToRoomVertices(
    delta: Vector2,
    roomVertices: Vector2[]
  ): {
    delta: Vector2;
    guides: Array<{ axis: 'x' | 'y'; value: number; from: Vector2; to: Vector2 }>;
  } {
    const threshold = 0.5;
    let bestDx: number | null = null;
    let bestDy: number | null = null;
    let snapXFrom: Vector2 | null = null;
    let snapXTo: Vector2 | null = null;
    let snapYFrom: Vector2 | null = null;
    let snapYTo: Vector2 | null = null;

    // Check each obstacle vertex against each room vertex
    for (const [, originalPos] of this.originalVertexPositions) {
      const movedPos = {
        x: originalPos.x + delta.x,
        y: originalPos.y + delta.y,
      };

      for (const rv of roomVertices) {
        const dx = rv.x - movedPos.x;
        const dy = rv.y - movedPos.y;

        if (Math.abs(dx) < threshold && (bestDx === null || Math.abs(dx) < Math.abs(bestDx))) {
          bestDx = dx;
          snapXFrom = movedPos;
          snapXTo = rv;
        }
        if (Math.abs(dy) < threshold && (bestDy === null || Math.abs(dy) < Math.abs(bestDy))) {
          bestDy = dy;
          snapYFrom = movedPos;
          snapYTo = rv;
        }
      }
    }

    const snappedDelta = { ...delta };
    const guides: Array<{ axis: 'x' | 'y'; value: number; from: Vector2; to: Vector2 }> = [];

    if (bestDx !== null && snapXFrom && snapXTo) {
      snappedDelta.x += bestDx;
      guides.push({
        axis: 'x',
        value: snapXTo.x,
        from: { x: snapXTo.x, y: Math.min(snapXFrom.y, snapXTo.y) - 1 },
        to: { x: snapXTo.x, y: Math.max(snapXFrom.y, snapXTo.y) + 1 },
      });
    }
    if (bestDy !== null && snapYFrom && snapYTo) {
      snappedDelta.y += bestDy;
      guides.push({
        axis: 'y',
        value: snapYTo.y,
        from: { x: Math.min(snapYFrom.x, snapYTo.x) - 1, y: snapYTo.y },
        to: { x: Math.max(snapYFrom.x, snapYTo.x) + 1, y: snapYTo.y },
      });
    }

    return { delta: snappedDelta, guides };
  }

  protected cleanup(): void {
    this.obstacleId = null;
    this.originalVertexPositions.clear();
    this.startPosition = null;
  }
}
