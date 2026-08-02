import type { Vector2, EditorCommand } from '../../types';
import type { DragStartContext, DragUpdateContext } from '../../types/interaction';
import type { SnapController } from '../../controllers/SnapController';
import type { DragOperationCallbacks } from '../DragManager';
import { BaseDragOperation } from '../DragOperation';

export interface ObstacleVertexDragConfig {
  snapController: SnapController;
  getGridSnapEnabled: () => boolean;
  getGridSize: () => number;
  getRoomVertices: () => Vector2[];
}

/**
 * Handles dragging obstacle vertices.
 * Updates the obstacle's wall segments when vertices are moved.
 * Supports grid snapping, axis locking, and shift-alignment to room vertices.
 */
export class ObstacleVertexDragOperation extends BaseDragOperation {
  readonly type = 'obstacle-vertex';

  private obstacleId: string | null = null;
  private anchorVertexIndex: number | null = null;
  private allVertices: Vector2[] = [];
  private originalVertexPositions: Map<number, Vector2> = new Map();
  private config: ObstacleVertexDragConfig;
  private callbacks: DragOperationCallbacks;

  constructor(config: ObstacleVertexDragConfig, callbacks: DragOperationCallbacks) {
    super();
    this.config = config;
    this.callbacks = callbacks;
  }

  setObstacleId(obstacleId: string): void {
    this.obstacleId = obstacleId;
  }

  setAnchorVertex(vertexIndex: number): void {
    this.anchorVertexIndex = vertexIndex;
  }

  /**
   * Provide all obstacle vertex positions. Originals are stored in start().
   */
  setObstacleVertices(vertices: Vector2[]): void {
    this.allVertices = vertices.map((v) => ({ ...v }));
  }

  start(context: DragStartContext): void {
    if (!this.obstacleId || this.anchorVertexIndex === null) return;

    this._isActive = true;

    // Build the set of selected indices from context + anchor
    const selectedIndices = new Set(context.selection.selectedObstacleVertexIndices);
    selectedIndices.add(this.anchorVertexIndex);

    // Store original positions only for selected vertices
    this.originalVertexPositions.clear();
    for (const idx of selectedIndices) {
      if (this.allVertices[idx]) {
        this.originalVertexPositions.set(idx, { ...this.allVertices[idx] });
      }
    }

    // Set start position to anchor's original position
    const anchorPos = this.originalVertexPositions.get(this.anchorVertexIndex);
    if (anchorPos) {
      this.startPosition = { ...anchorPos };
    } else {
      this.startPosition = { ...context.position };
    }
  }

  update(context: DragUpdateContext): EditorCommand | null {
    if (!this._isActive || !this.obstacleId || !this.startPosition) return null;

    let targetPos = context.position;

    // Apply axis lock
    if (context.axisLock !== 'none') {
      targetPos = this.applyAxisConstraint(targetPos, context.axisLock, this.startPosition);
    }

    // Shift-held: snap to other vertices of the same obstacle
    if (context.modifiers.shiftKey && this.originalVertexPositions.size === 1) {
      // Build list of obstacle vertices that are NOT being dragged
      const snapTargets = this.allVertices.filter((_, i) => !this.originalVertexPositions.has(i));
      const result = this.config.snapController.snapToVertices(
        targetPos,
        snapTargets,
        -1 // No exclusion index needed - already filtered
      );
      targetPos = result.snappedPos;
      if (result.guides.length > 0) {
        this.callbacks.onSetSnapGuides(result.guides);
      } else {
        this.callbacks.onSetSnapGuides([]);
      }
    } else if (this.config.getGridSnapEnabled()) {
      // Apply grid snapping when shift is NOT held
      const gridSize = this.config.getGridSize();
      if (gridSize > 0) {
        targetPos = this.config.snapController.snapToGrid(targetPos, gridSize);
      }
      this.callbacks.onSetSnapGuides([]);
    } else {
      this.callbacks.onSetSnapGuides([]);
    }

    // Calculate delta from anchor's original position
    const anchorOriginal =
      this.anchorVertexIndex !== null
        ? this.originalVertexPositions.get(this.anchorVertexIndex)
        : null;

    if (!anchorOriginal) return null;

    const delta = this.calculateDelta(anchorOriginal, targetPos);

    const commands: EditorCommand[] = [];
    for (const [index, originalPos] of this.originalVertexPositions) {
      commands.push({
        type: 'obstacle.vertex.move',
        obstacleId: this.obstacleId,
        index,
        position: { x: originalPos.x + delta.x, y: originalPos.y + delta.y },
      });
    }

    if (commands.length === 0) return null;
    if (commands.length === 1) return commands[0];
    return { type: 'compound', label: 'Move obstacle vertices', commands };
  }

  finish(): void {
    this.callbacks.onSetSnapGuides([]);
    super.finish();
  }

  protected cleanup(): void {
    this.obstacleId = null;
    this.anchorVertexIndex = null;
    this.allVertices = [];
    this.originalVertexPositions.clear();
    this.startPosition = null;
  }
}
