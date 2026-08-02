import type { Vector2, EditorCommand } from '../../types';
import type { DragStartContext, DragUpdateContext } from '../../types/interaction';
import { getSelectedVertexIndices, type Selection } from '../../types/selection';
import type { DragOperationCallbacks } from '../DragManager';
import type { BaseDragConfig } from '../types';
import { BaseDragOperation } from '../DragOperation';
import { calculateDelta, checkPointInRoom, processTargetWithSnapping } from './grabModeHelpers';

/**
 * Configuration for unified drag operations.
 * Extends BaseDragConfig with no additional properties.
 */
export type UnifiedDragConfig = BaseDragConfig;

export interface UnifiedDragCallbacks extends DragOperationCallbacks {
  onMeasurementUpdate?: (delta: Vector2) => void;
}

/**
 * Handles unified dragging of multiple room vertices and/or module entities.
 * Supports axis locking, grid snapping, and vertex/entity alignment snapping.
 *
 * A heterogeneous selection resolves to one compound command — one history entry made of the
 * per-entity absolute moves.
 */
export class UnifiedDragOperation extends BaseDragOperation {
  readonly type = 'unified';

  private originalVertexPositions: Map<number, Vector2> = new Map();
  private originalEntityPositions: Map<string, Vector2> = new Map();
  private anchorVertexIndex: number | null = null;
  private anchorEntityId: string | null = null;
  private selection: Selection | null = null;
  private config: UnifiedDragConfig;
  private callbacks: UnifiedDragCallbacks;

  constructor(config: UnifiedDragConfig, callbacks: UnifiedDragCallbacks) {
    super();
    this.config = config;
    this.callbacks = callbacks;
  }

  /**
   * Set the anchor point for the drag operation.
   * The anchor is the item that was clicked to initiate the drag.
   */
  setAnchor(vertexIndex: number | null, entityId: string | null): void {
    this.anchorVertexIndex = vertexIndex;
    this.anchorEntityId = entityId;
  }

  start(context: DragStartContext): void {
    this._isActive = true;
    this.selection = context.selection;

    const vertices = this.config.getVertices();

    // Store original positions of all selected vertices
    this.originalVertexPositions.clear();
    for (const idx of getSelectedVertexIndices(context.selection)) {
      if (vertices[idx]) {
        this.originalVertexPositions.set(idx, { ...vertices[idx] });
      }
    }

    // Store original positions of all selected module entities
    this.originalEntityPositions.clear();
    const entities = this.config.getEntities();
    for (const id of entities.selectedIds(context.selection)) {
      const entity = entities.find(id);
      if (entity) {
        this.originalEntityPositions.set(id, { ...entity.position });
      }
    }

    // Set startPosition to the anchor's actual position (not mouse position)
    // This ensures axis lock works correctly relative to the item's original position
    if (
      this.anchorVertexIndex !== null &&
      this.originalVertexPositions.has(this.anchorVertexIndex)
    ) {
      this.startPosition = { ...this.originalVertexPositions.get(this.anchorVertexIndex)! };
    } else if (
      this.anchorEntityId !== null &&
      this.originalEntityPositions.has(this.anchorEntityId)
    ) {
      this.startPosition = { ...this.originalEntityPositions.get(this.anchorEntityId)! };
    } else {
      // Fallback to mouse position if no anchor (shouldn't happen)
      this.startPosition = { ...context.position };
    }
  }

  update(context: DragUpdateContext): EditorCommand | null {
    if (!this._isActive || !this.startPosition || !this.selection) return null;

    const snapResult = processTargetWithSnapping(
      context.position,
      this.startPosition,
      context,
      this.config,
      {
        selection: this.selection,
        anchorVertexIndex: this.anchorVertexIndex,
        anchorEntityId: this.anchorEntityId,
        getVertices: this.config.getVertices,
        getEntities: this.config.getEntities,
      },
      this.applyAxisConstraint.bind(this)
    );

    if (snapResult.guides.length > 0) {
      this.callbacks.onSetSnapGuides(snapResult.guides);
    } else if (snapResult.clearGuides) {
      this.callbacks.onSetSnapGuides([]);
    }

    // Calculate delta from anchor point
    const delta = this.calculateDeltaFromAnchor(snapResult.position);

    const commands: EditorCommand[] = [
      ...this.vertexMoveCommands(delta),
      ...this.entityMoveCommands(delta),
    ];

    // Notify measurement update if callback provided
    if (this.callbacks.onMeasurementUpdate) {
      this.callbacks.onMeasurementUpdate(delta);
    }

    if (commands.length === 0) return null;
    if (commands.length === 1) return commands[0];
    return { type: 'compound', label: 'Move selection', commands };
  }

  private calculateDeltaFromAnchor(targetPos: Vector2): Vector2 {
    if (
      this.anchorVertexIndex !== null &&
      this.originalVertexPositions.has(this.anchorVertexIndex)
    ) {
      return calculateDelta(this.originalVertexPositions.get(this.anchorVertexIndex)!, targetPos);
    }
    if (this.anchorEntityId !== null && this.originalEntityPositions.has(this.anchorEntityId)) {
      return calculateDelta(this.originalEntityPositions.get(this.anchorEntityId)!, targetPos);
    }
    return { x: 0, y: 0 };
  }

  private vertexMoveCommands(delta: Vector2): EditorCommand[] {
    const commands: EditorCommand[] = [];
    for (const [index, originalPos] of this.originalVertexPositions) {
      commands.push({
        type: 'vertex.move',
        index,
        position: { x: originalPos.x + delta.x, y: originalPos.y + delta.y },
      });
    }
    return commands;
  }

  private entityMoveCommands(delta: Vector2): EditorCommand[] {
    if (this.originalEntityPositions.size === 0) return [];

    const entities = this.config.getEntities();
    const walls = this.config.getWalls();
    const isClosed = this.config.isRoomClosed();
    const commands: EditorCommand[] = [];

    for (const [entityId, originalPos] of this.originalEntityPositions) {
      const position = { x: originalPos.x + delta.x, y: originalPos.y + delta.y };

      // Only move if inside room (when room is closed)
      if (!isClosed || checkPointInRoom(position, walls)) {
        commands.push(entities.moveCommand(entityId, position));
      }
    }

    return commands;
  }

  protected cleanup(): void {
    this.originalVertexPositions.clear();
    this.originalEntityPositions.clear();
    this.anchorVertexIndex = null;
    this.anchorEntityId = null;
    this.selection = null;
    this.startPosition = null;
  }
}
