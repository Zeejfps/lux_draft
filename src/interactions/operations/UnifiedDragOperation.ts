import type { Vector2, EditorCommand } from '../../types';
import type { DragStartContext, DragUpdateContext } from '../../types/interaction';
import { getSelectedVertexIndices, type Selection } from '../../types/selection';
import { getSelectedFixtureIds } from '../../lighting/selection';
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
 * Handles unified dragging of multiple vertices and/or lights.
 * Supports axis locking, grid snapping, and vertex/light alignment snapping.
 *
 * A heterogeneous selection resolves to one compound command — one history entry made of the
 * per-entity absolute moves.
 */
export class UnifiedDragOperation extends BaseDragOperation {
  readonly type = 'unified';

  private originalVertexPositions: Map<number, Vector2> = new Map();
  private originalLightPositions: Map<string, Vector2> = new Map();
  private anchorVertexIndex: number | null = null;
  private anchorLightId: string | null = null;
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
  setAnchor(vertexIndex: number | null, lightId: string | null): void {
    this.anchorVertexIndex = vertexIndex;
    this.anchorLightId = lightId;
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

    // Store original positions of all selected lights
    this.originalLightPositions.clear();
    const lights = this.config.getLights();
    for (const id of getSelectedFixtureIds(context.selection)) {
      const light = lights.find((l) => l.id === id);
      if (light) {
        this.originalLightPositions.set(id, { ...light.position });
      }
    }

    // Set startPosition to the anchor's actual position (not mouse position)
    // This ensures axis lock works correctly relative to the item's original position
    if (
      this.anchorVertexIndex !== null &&
      this.originalVertexPositions.has(this.anchorVertexIndex)
    ) {
      this.startPosition = { ...this.originalVertexPositions.get(this.anchorVertexIndex)! };
    } else if (this.anchorLightId !== null && this.originalLightPositions.has(this.anchorLightId)) {
      this.startPosition = { ...this.originalLightPositions.get(this.anchorLightId)! };
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
        anchorLightId: this.anchorLightId,
        getVertices: this.config.getVertices,
        getLights: this.config.getLights,
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
      ...this.lightMoveCommands(delta),
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
    if (this.anchorLightId !== null && this.originalLightPositions.has(this.anchorLightId)) {
      return calculateDelta(this.originalLightPositions.get(this.anchorLightId)!, targetPos);
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

  private lightMoveCommands(delta: Vector2): EditorCommand[] {
    if (this.originalLightPositions.size === 0) return [];

    const walls = this.config.getWalls();
    const isClosed = this.config.isRoomClosed();
    const commands: EditorCommand[] = [];

    for (const [lightId, originalPos] of this.originalLightPositions) {
      const position = { x: originalPos.x + delta.x, y: originalPos.y + delta.y };

      // Only move if inside room (when room is closed)
      if (!isClosed || checkPointInRoom(position, walls)) {
        commands.push({ type: 'light.move', lightId, position });
      }
    }

    return commands;
  }

  protected cleanup(): void {
    this.originalVertexPositions.clear();
    this.originalLightPositions.clear();
    this.anchorVertexIndex = null;
    this.anchorLightId = null;
    this.selection = null;
    this.startPosition = null;
  }
}
