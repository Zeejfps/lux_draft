import type { InputEvent } from '../../core/InputManager';
import type { Vector2, WallSegment, Door, Obstacle } from '../../types';
import type { InteractionContext } from '../../types/interaction';
import {
  getSelectedObstacleId,
  getSelectedObstacleVertexIndices,
  getSelectedVertexIndices,
  type Selection,
} from '../../types/selection';
import type { EntityAccess } from '../../types/entity';
import type { DragManager } from '../DragManager';
import type { UnifiedDragOperation } from '../operations/UnifiedDragOperation';
import type { WallDragOperation } from '../operations/WallDragOperation';
import type { DoorDragOperation } from '../operations/DoorDragOperation';
import type { ObstacleVertexDragOperation } from '../operations/ObstacleVertexDragOperation';
import type { ObstacleDragOperation } from '../operations/ObstacleDragOperation';
import type { BoxSelectionHandler } from './BoxSelectionHandler';
import { BaseInteractionHandler } from '../InteractionHandler';
import {
  findVertexAtPosition,
  projectPointOntoSegmentForInsertion,
  distancePointToSegment,
} from '../../utils/math';
import { getDoorEndpoints, isPointInPolygon } from '../../utils/geometry';
import { VERTEX_HIT_TOLERANCE_FT, DOOR_HIT_TOLERANCE_FT } from '../../constants/editor';
import { attemptItemSelection, handleSelectionAction } from './selectionHelpers';
import {
  EMPTY_MODIFIERS,
  hasSelection,
  getSelectionOriginFromDocument,
  handleAxisLockKey,
} from '../utils';

/**
 * Selection is one value, so there is no `onClear*Selection` per entity kind: selecting
 * anything replaces everything else structurally. `onClearSelection` is the only clear left,
 * and it means "select nothing".
 */
export interface SelectionHandlerCallbacks {
  onSelectVertex: (index: number, addToSelection: boolean) => void;
  onSelectEntity: (id: string, addToSelection: boolean) => void;
  onSelectWall: (id: string) => void;
  onSelectDoor: (id: string) => void;
  onSelectObstacle: (id: string) => void;
  onSelectObstacleVertex: (
    obstacleId: string,
    vertexIndex: number,
    addToSelection: boolean
  ) => void;
  onClearSelection: () => void;
  /** Shift+box-drag in empty space: keep what a box can extend, drop the rest. */
  onRetainBoxCandidates: () => void;
  onInsertVertex: (wallId: string, position: Vector2) => number | null;
  getWallAtPosition: (pos: Vector2, walls: WallSegment[], tolerance: number) => WallSegment | null;
  getDoors: () => Door[];
  getObstacles: () => Obstacle[];
}

export interface SelectionHandlerConfig {
  getEntities: () => EntityAccess;
  dragManager: DragManager;
  boxSelectionHandler: BoxSelectionHandler;
  createUnifiedDragOperation: () => UnifiedDragOperation;
  createWallDragOperation: () => WallDragOperation;
  createDoorDragOperation: () => DoorDragOperation;
  createObstacleVertexDragOperation: () => ObstacleVertexDragOperation;
  createObstacleDragOperation: () => ObstacleDragOperation;
  getSelection: () => Selection;
  getCurrentMousePos: () => Vector2;
}

/**
 * Handles selection of vertices, module entities, and walls.
 * Manages single click selection, shift-click multi-selection,
 * and initiates drag operations.
 */
export class SelectionHandler extends BaseInteractionHandler {
  readonly name = 'selection';
  readonly priority = 50;

  private config: SelectionHandlerConfig;
  private callbacks: SelectionHandlerCallbacks;

  constructor(config: SelectionHandlerConfig, callbacks: SelectionHandlerCallbacks) {
    super();
    this.config = config;
    this.callbacks = callbacks;
  }

  canHandle(_event: InputEvent, context: InteractionContext): boolean {
    // Selection handler is the fallback for click events in select mode
    return (
      !context.isDrawingEnabled &&
      !context.isModuleToolActive &&
      !context.isPlacingDoors &&
      !context.isObstacleDrawing &&
      !context.isMeasuring
    );
  }

  handleClick(event: InputEvent, context: InteractionContext): boolean {
    const pos = event.worldPos;
    const addToSelection = event.shiftKey ?? false;
    const { document: doc, vertices } = context;
    const walls = doc.geometry.boundary.walls;
    const isClosed = doc.geometry.boundary.isClosed;

    // Check vertices first (if room is closed)
    if (isClosed) {
      const vertexResult = this.trySelectVertex(pos, vertices, addToSelection);
      if (vertexResult.handled) return true;
    }

    // Check the active module's entities
    const entityResult = this.trySelectEntity(pos, vertices, addToSelection);
    if (entityResult.handled) return true;

    // Check doors (if room is closed)
    if (isClosed) {
      const doorResult = this.trySelectDoor(pos, walls);
      if (doorResult.handled) return true;
    }

    // Check obstacle vertices (if room is closed)
    if (isClosed) {
      const obstacleVertexResult = this.trySelectObstacleVertex(pos, addToSelection);
      if (obstacleVertexResult.handled) return true;
    }

    // Check obstacles (if room is closed)
    if (isClosed) {
      const obstacleResult = this.trySelectObstacle(pos);
      if (obstacleResult.handled) return true;
    }

    // Check walls (if room is closed)
    if (isClosed) {
      const wallResult = this.trySelectWall(pos, walls);
      if (wallResult.handled) return true;
    }

    // Start box selection in empty space
    if (isClosed) {
      if (!addToSelection) {
        this.callbacks.onClearSelection();
      } else {
        // Keep only what a box drag can extend; the wall/door/obstacle parts go.
        this.callbacks.onRetainBoxCandidates();
      }
      this.config.boxSelectionHandler.startBoxSelection(pos);
      return true;
    }

    // Clear selection if clicking on empty space (unless shift is held)
    if (!addToSelection) {
      this.callbacks.onClearSelection();
    }

    return true;
  }

  handleDoubleClick(event: InputEvent, context: InteractionContext): boolean {
    const { document: doc } = context;
    if (!doc.geometry.boundary.isClosed) return false;

    const wall = this.callbacks.getWallAtPosition(
      event.worldPos,
      doc.geometry.boundary.walls,
      VERTEX_HIT_TOLERANCE_FT
    );

    if (wall) {
      const insertPos = projectPointOntoSegmentForInsertion(event.worldPos, wall.start, wall.end);
      const newVertexIndex = this.callbacks.onInsertVertex(wall.id, insertPos);

      if (newVertexIndex !== null) {
        this.callbacks.onSelectVertex(newVertexIndex, false);
      }
      return true;
    }

    return false;
  }

  handleMouseUp(_event: InputEvent, _context: InteractionContext): boolean {
    // Commit any active drag
    if (this.config.dragManager.isActive) {
      this.config.dragManager.commitDrag();
      return true;
    }
    return false;
  }

  handleKeyDown(event: InputEvent, context: InteractionContext): boolean {
    // Axis lock for selected objects (can be set before or during drag)
    const selection = this.config.getSelection();
    const selectionExists = hasSelection(selection);

    if (selectionExists && !context.isGrabMode) {
      if (
        handleAxisLockKey(event, {
          dragManager: this.config.dragManager,
          getGuideOrigin: () =>
            this.config.dragManager.startPosition || this.getSelectionOrigin(context),
          // Only trigger immediate update if actively dragging
          triggerImmediateUpdate: this.config.dragManager.isActive
            ? () => this.triggerImmediateUpdate()
            : undefined,
        })
      ) {
        return true;
      }
    }

    // Escape clears selection or axis lock
    if (event.key === 'Escape') {
      if (this.config.dragManager.axisLock !== 'none') {
        this.config.dragManager.clearAxisLock();
        return true;
      }
      if (selectionExists) {
        this.callbacks.onClearSelection();
        return true;
      }
    }

    return false;
  }

  private trySelectVertex(
    pos: Vector2,
    vertices: Vector2[],
    addToSelection: boolean
  ): { handled: boolean } {
    const entities = this.config.getEntities();
    const selectedIndices = getSelectedVertexIndices(this.config.getSelection());
    const selectedEntityIds = entities.selectedIds(this.config.getSelection());

    const attempt = attemptItemSelection<number>(pos, {
      findItemAtPosition: (p, tolerance) => {
        const idx = findVertexAtPosition(p, vertices, tolerance);
        return idx !== null ? { id: idx, position: vertices[idx] } : null;
      },
      isSelected: (idx) => selectedIndices.includes(idx),
      getOtherSelectedCount: () => selectedIndices.length - 1 + selectedEntityIds.length,
      hitTolerance: VERTEX_HIT_TOLERANCE_FT,
    });

    const handled = handleSelectionAction(attempt, addToSelection, {
      onSelect: (idx, add) => this.callbacks.onSelectVertex(idx, add),
      isSelectedNow: (idx) => getSelectedVertexIndices(this.config.getSelection()).includes(idx),
      startDrag: (idx) => this.startUnifiedDrag(idx, null, pos, vertices),
    });

    return { handled };
  }

  private trySelectEntity(
    pos: Vector2,
    vertices: Vector2[],
    addToSelection: boolean
  ): { handled: boolean } {
    const entities = this.config.getEntities();
    const selectedIndices = getSelectedVertexIndices(this.config.getSelection());
    const selectedEntityIds = entities.selectedIds(this.config.getSelection());

    const attempt = attemptItemSelection<string>(pos, {
      findItemAtPosition: (p, tolerance) => {
        const entity = entities.at(p, tolerance);
        return entity ? { id: entity.id, position: entity.position } : null;
      },
      isSelected: (id) => selectedEntityIds.includes(id),
      getOtherSelectedCount: () => selectedEntityIds.length - 1 + selectedIndices.length,
      hitTolerance: entities.hitTolerance,
    });

    const handled = handleSelectionAction(attempt, addToSelection, {
      onSelect: (id, add) => this.callbacks.onSelectEntity(id, add),
      isSelectedNow: (id) =>
        this.config.getEntities().selectedIds(this.config.getSelection()).includes(id),
      startDrag: (id) => this.startUnifiedDrag(null, id, pos, vertices),
    });

    return { handled };
  }

  private trySelectDoor(pos: Vector2, walls: WallSegment[]): { handled: boolean } {
    const doors = this.callbacks.getDoors();
    const door = this.getDoorAtPosition(pos, doors, walls, DOOR_HIT_TOLERANCE_FT);
    if (!door) return { handled: false };

    this.callbacks.onSelectDoor(door.id);

    // Start door drag
    const operation = this.config.createDoorDragOperation();
    operation.setDoorId(door.id);

    this.config.dragManager.startDrag(operation, {
      position: pos,
      modifiers: EMPTY_MODIFIERS,
      document: null,
      selection: this.config.getSelection(),
    });

    return { handled: true };
  }

  private getDoorAtPosition(
    pos: Vector2,
    doors: Door[],
    walls: WallSegment[],
    tolerance: number
  ): Door | null {
    for (const door of doors) {
      const wall = walls.find((w) => w.id === door.wallId);
      if (!wall) continue;

      const { start, end } = getDoorEndpoints(door, wall);

      // Check if click is near door segment
      const dist = distancePointToSegment(pos, start, end);
      if (dist <= tolerance) {
        return door;
      }
    }
    return null;
  }

  private trySelectObstacleVertex(pos: Vector2, addToSelection: boolean): { handled: boolean } {
    const obstacles = this.callbacks.getObstacles();
    const selectedObstacleVertexIndices = getSelectedObstacleVertexIndices(
      this.config.getSelection()
    );

    for (const obstacle of obstacles) {
      const vertices = obstacle.walls.map((w) => w.start);
      const idx = findVertexAtPosition(pos, vertices, VERTEX_HIT_TOLERANCE_FT);

      if (idx !== null) {
        const isAlreadySelected = selectedObstacleVertexIndices.includes(idx);
        const isThisObstacleSelected =
          getSelectedObstacleId(this.config.getSelection()) === obstacle.id;

        if (addToSelection && isThisObstacleSelected) {
          // Toggle vertex in/out of selection within same obstacle
          this.callbacks.onSelectObstacleVertex(obstacle.id, idx, true);
          if (isAlreadySelected) {
            // Toggled off - check if still selected after update
            const nowSelected = getSelectedObstacleVertexIndices(this.config.getSelection());
            if (!nowSelected.includes(idx)) {
              return { handled: true };
            }
          }
        } else if (
          isAlreadySelected &&
          isThisObstacleSelected &&
          selectedObstacleVertexIndices.length > 1
        ) {
          // Clicking on already-selected vertex in multi-select: start drag
        } else {
          // Single select
          this.callbacks.onSelectObstacleVertex(obstacle.id, idx, false);
        }

        // Start drag
        this.startObstacleVertexDrag(obstacle.id, idx, pos, vertices);

        return { handled: true };
      }
    }

    return { handled: false };
  }

  private startObstacleVertexDrag(
    obstacleId: string,
    vertexIndex: number,
    pos: Vector2,
    vertices: Vector2[]
  ): void {
    const operation = this.config.createObstacleVertexDragOperation();
    operation.setObstacleId(obstacleId);
    operation.setAnchorVertex(vertexIndex);
    operation.setObstacleVertices(vertices);

    this.config.dragManager.startDrag(operation, {
      position: pos,
      modifiers: EMPTY_MODIFIERS,
      document: null,
      selection: this.config.getSelection(),
    });
  }

  private trySelectObstacle(pos: Vector2): { handled: boolean } {
    const obstacles = this.callbacks.getObstacles();
    const WALL_TOLERANCE = 0.3;

    for (const obstacle of obstacles) {
      let hit = false;

      // Check if click is near any obstacle wall segment
      for (const wall of obstacle.walls) {
        const dist = distancePointToSegment(pos, wall.start, wall.end);
        if (dist <= WALL_TOLERANCE) {
          hit = true;
          break;
        }
      }

      // Check if click is inside obstacle polygon
      if (!hit) {
        const vertices = obstacle.walls.map((w) => w.start);
        if (isPointInPolygon(pos, vertices)) {
          hit = true;
        }
      }

      if (hit) {
        this.callbacks.onSelectObstacle(obstacle.id);

        // Start whole-obstacle drag
        this.startObstacleDrag(
          obstacle.id,
          pos,
          obstacle.walls.map((w) => w.start)
        );

        return { handled: true };
      }
    }

    return { handled: false };
  }

  private startObstacleDrag(obstacleId: string, pos: Vector2, vertices: Vector2[]): void {
    const operation = this.config.createObstacleDragOperation();
    operation.setObstacleId(obstacleId);
    operation.setObstacleVertices(vertices);

    this.config.dragManager.startDrag(operation, {
      position: pos,
      modifiers: EMPTY_MODIFIERS,
      document: null,
      selection: this.config.getSelection(),
    });
  }

  private trySelectWall(pos: Vector2, walls: WallSegment[]): { handled: boolean } {
    const wall = this.callbacks.getWallAtPosition(pos, walls, VERTEX_HIT_TOLERANCE_FT);
    if (!wall) return { handled: false };

    this.callbacks.onSelectWall(wall.id);

    // Start wall drag
    const operation = this.config.createWallDragOperation();
    operation.setWallId(wall.id);

    this.config.dragManager.startDrag(operation, {
      position: pos,
      modifiers: EMPTY_MODIFIERS,
      document: null,
      selection: this.config.getSelection(),
    });

    return { handled: true };
  }

  private startUnifiedDrag(
    vertexIndex: number | null,
    entityId: string | null,
    pos: Vector2,
    _vertices: Vector2[]
  ): void {
    const operation = this.config.createUnifiedDragOperation();
    operation.setAnchor(vertexIndex, entityId);

    this.config.dragManager.startDrag(operation, {
      position: pos,
      modifiers: EMPTY_MODIFIERS,
      document: null,
      selection: this.config.getSelection(),
    });
  }

  /**
   * Trigger an immediate drag update with the current mouse position.
   * This ensures the object position updates immediately when axis lock changes.
   */
  private triggerImmediateUpdate(): void {
    const currentPos = this.config.getCurrentMousePos();
    this.config.dragManager.updateDrag(currentPos, EMPTY_MODIFIERS);
  }

  private getSelectionOrigin(context: InteractionContext): Vector2 | undefined {
    const selection = this.config.getSelection();
    return getSelectionOriginFromDocument(
      selection,
      context.vertices,
      context.entities,
      context.document.geometry.boundary.walls,
      context.document.geometry.doors
    );
  }
}
