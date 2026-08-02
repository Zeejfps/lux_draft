import type { Vector2, EditorCommand } from '../../types';
import type { DragStartContext, DragUpdateContext } from '../../types/interaction';
import type { Selection } from '../../types/selection';
import type { DragOperationCallbacks } from '../DragManager';
import type { BaseDragConfig, RoomStateWithDoors } from '../types';
import { BaseDragOperation } from '../DragOperation';
import { doorPositioningService } from '../../services';
import { moveFixture } from '../../../modules/lighting/commands';
import {
  calculateGrabOffset,
  applyGrabOffset,
  findAnchorPosition,
  calculateDelta,
  applyDelta,
  checkPointInRoom,
  captureOriginalPositions,
  processTargetWithSnapping,
  applyWallSnappingWithGuides,
} from './grabModeHelpers';

/**
 * Configuration for grab mode drag operations.
 * Extends BaseDragConfig with door access and mouse position.
 */
export interface GrabModeConfig extends BaseDragConfig, RoomStateWithDoors {
  getCurrentMousePos: () => Vector2;
}

/**
 * Handles grab mode (G key) which allows moving selected items
 * by moving the mouse without clicking and dragging.
 *
 * The offset between the mouse and the anchor object is preserved,
 * so the object follows the mouse at a fixed distance.
 *
 * **Heterogeneous selections resolve to a compound command**, not a bespoke multi-entity one:
 * a grab can hold room vertices and lights at once, and there is no single entity a
 * multi-entity payload could name. Each member carries its own absolute target, so the
 * compound is idempotent exactly as its members are, it reuses the same handlers as a
 * single-entity drag, and it is still one preview, one dispatch, one history entry.
 */
export class GrabModeDragOperation extends BaseDragOperation {
  readonly type = 'grabMode';

  private originalVertexPositions: Map<number, Vector2> = new Map();
  private originalLightPositions: Map<string, Vector2> = new Map();
  private originalWallVertices: { start: Vector2; end: Vector2 } | null = null;
  private originalDoorPosition: number | null = null;
  private anchorVertexIndex: number | null = null;
  private anchorLightId: string | null = null;
  private wallId: string | null = null;
  private doorId: string | null = null;
  private selection: Selection | null = null;
  private config: GrabModeConfig;
  private callbacks: DragOperationCallbacks;

  // Offset from mouse position to anchor object position when grab started
  private grabOffset: Vector2 | null = null;

  constructor(config: GrabModeConfig, callbacks: DragOperationCallbacks) {
    super();
    this.config = config;
    this.callbacks = callbacks;
  }

  start(context: DragStartContext): void {
    this._isActive = true;
    this.selection = context.selection;

    const currentMousePos = this.config.getCurrentMousePos();

    // Capture original positions for all selected items
    const captured = captureOriginalPositions(
      context.selection,
      this.config.getVertices,
      this.config.getLights,
      this.config.getWallById,
      this.config.getDoorById
    );

    this.originalVertexPositions = captured.vertexPositions;
    this.originalLightPositions = captured.lightPositions;
    this.originalWallVertices = captured.wallVertices;
    this.originalDoorPosition = captured.doorPosition;

    // Find anchor position
    const anchor = findAnchorPosition(
      context.selection,
      this.config.getVertices,
      this.config.getLights,
      this.config.getWallById,
      this.config.getDoorById
    );

    // Store anchor identifiers
    if (anchor.anchorType === 'vertex') {
      this.anchorVertexIndex = anchor.anchorId as number;
    } else if (anchor.anchorType === 'light') {
      this.anchorLightId = anchor.anchorId as string;
    } else if (anchor.anchorType === 'wall') {
      this.wallId = anchor.anchorId as string;
    } else if (anchor.anchorType === 'door') {
      this.doorId = anchor.anchorId as string;
    }

    if (anchor.anchorPos) {
      this.grabOffset = calculateGrabOffset(anchor.anchorPos, currentMousePos);
      this.startPosition = { ...anchor.anchorPos };
    }
  }

  update(context: DragUpdateContext): EditorCommand | null {
    if (!this._isActive || !this.grabOffset || !this.startPosition) return null;

    // Adjust position with offset (as if we clicked on the object)
    const adjustedPos = applyGrabOffset(context.position, this.grabOffset);

    // Handle door separately if only door is selected
    if (
      this.doorId &&
      this.originalDoorPosition !== null &&
      this.originalVertexPositions.size === 0 &&
      this.originalLightPositions.size === 0 &&
      !this.wallId
    ) {
      return this.doorCommand(context.position);
    }

    // Handle wall separately if only wall is selected
    if (
      this.wallId &&
      this.originalWallVertices &&
      this.originalVertexPositions.size === 0 &&
      this.originalLightPositions.size === 0
    ) {
      return this.wallCommand(adjustedPos, context);
    }

    return this.verticesAndLightsCommand(adjustedPos, context);
  }

  private verticesAndLightsCommand(
    adjustedPos: Vector2,
    context: DragUpdateContext
  ): EditorCommand | null {
    if (!this.startPosition || !this.selection) return null;

    const snapResult = processTargetWithSnapping(
      adjustedPos,
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

    const commands: EditorCommand[] = [];

    for (const [index, originalPos] of this.originalVertexPositions) {
      commands.push({ type: 'vertex.move', index, position: applyDelta(originalPos, delta) });
    }

    if (this.originalLightPositions.size > 0) {
      const walls = this.config.getWalls();
      const isClosed = this.config.isRoomClosed();

      for (const [lightId, originalPos] of this.originalLightPositions) {
        const position = applyDelta(originalPos, delta);
        if (!isClosed || checkPointInRoom(position, walls)) {
          commands.push(moveFixture.make({ fixtureId: lightId, position }));
        }
      }
    }

    if (commands.length === 0) return null;
    if (commands.length === 1) return commands[0];
    return { type: 'compound', label: 'Move selection', commands };
  }

  private wallCommand(adjustedPos: Vector2, context: DragUpdateContext): EditorCommand | null {
    if (!this.wallId || !this.originalWallVertices || !this.startPosition) return null;

    let constrainedPos = adjustedPos;

    if (context.axisLock !== 'none') {
      constrainedPos = this.applyAxisConstraint(adjustedPos, context.axisLock, this.startPosition);
    }

    const delta = calculateDelta(this.startPosition, constrainedPos);

    const baseStart = applyDelta(this.originalWallVertices.start, delta);
    const baseEnd = applyDelta(this.originalWallVertices.end, delta);

    const { start, end } = applyWallSnappingWithGuides(
      baseStart,
      baseEnd,
      this.wallId,
      context,
      this.config,
      this.callbacks.onSetSnapGuides
    );

    return { type: 'wall.move', wallId: this.wallId, start, end };
  }

  private doorCommand(mousePos: Vector2): EditorCommand | null {
    if (!this.doorId || this.originalDoorPosition === null) return null;

    const door = this.config.getDoorById(this.doorId);
    if (!door) return null;

    const wall = this.config.getWallById(door.wallId);
    if (!wall) return null;

    // Calculate new position using the service
    const existingDoors = this.config.getDoorsByWallId(door.wallId);
    const offset = doorPositioningService.calculateDragPosition(
      mousePos,
      wall,
      door.width,
      existingDoors,
      this.doorId
    );

    return { type: 'door.move', doorId: this.doorId, offset };
  }

  private calculateDeltaFromAnchor(targetPos: Vector2): Vector2 {
    if (
      this.anchorVertexIndex !== null &&
      this.originalVertexPositions.has(this.anchorVertexIndex)
    ) {
      const anchorOriginal = this.originalVertexPositions.get(this.anchorVertexIndex)!;
      return calculateDelta(anchorOriginal, targetPos);
    }

    if (this.anchorLightId !== null && this.originalLightPositions.has(this.anchorLightId)) {
      const anchorOriginal = this.originalLightPositions.get(this.anchorLightId)!;
      return calculateDelta(anchorOriginal, targetPos);
    }

    return { x: 0, y: 0 };
  }

  protected cleanup(): void {
    this.originalVertexPositions.clear();
    this.originalLightPositions.clear();
    this.originalWallVertices = null;
    this.originalDoorPosition = null;
    this.anchorVertexIndex = null;
    this.anchorLightId = null;
    this.wallId = null;
    this.doorId = null;
    this.selection = null;
    this.startPosition = null;
    this.grabOffset = null;
  }
}
