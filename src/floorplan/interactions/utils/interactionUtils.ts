import type { Vector2, WallSegment, Door } from '../../types';
import type { EntityAccess } from '../../types/entity';
import type { InputModifiers } from '../../types/interaction';
import type { InputEvent } from '../../core/InputManager';
import {
  getSelectedDoorId,
  getSelectedVertexIndices,
  getSelectedWallId,
  isEmptySelection,
  type Selection,
} from '../../types/selection';
import { getWallDirection } from '../../utils/geometry';

/**
 * Default empty modifiers object for drag operations.
 */
export const EMPTY_MODIFIERS: InputModifiers = {
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
};

/**
 * Extracts modifier keys from an input event.
 */
export function extractModifiers(event: InputEvent): InputModifiers {
  return {
    shiftKey: event.shiftKey ?? false,
    ctrlKey: event.ctrlKey ?? false,
    altKey: event.altKey ?? false,
  };
}

/**
 * Checks if any item is selected.
 */
export function hasSelection(selection: Selection): boolean {
  return !isEmptySelection(selection);
}

/**
 * Configuration for getting selection origin.
 */
export interface SelectionOriginConfig {
  getVertices: () => Vector2[];
  getEntities: () => EntityAccess;
  getWalls: () => WallSegment[];
  getWallById: (id: string) => WallSegment | undefined;
  getDoorById: (id: string) => Door | undefined;
}

/**
 * Gets the position of the first selected object.
 * Used for axis lock guides and grab mode offset calculation.
 */
export function getSelectionOrigin(
  selection: Selection,
  config: SelectionOriginConfig
): Vector2 | null {
  const entities = config.getEntities();
  const selectedVertexIndices = getSelectedVertexIndices(selection);
  const selectedEntityIds = entities.selectedIds(selection);
  const selectedWallId = getSelectedWallId(selection);
  const selectedDoorId = getSelectedDoorId(selection);

  // Check vertices first
  if (selectedVertexIndices.length > 0) {
    const vertices = config.getVertices();
    const firstIndex = selectedVertexIndices[0];
    if (vertices[firstIndex]) {
      return { ...vertices[firstIndex] };
    }
  }

  // Check the active module's entities
  if (selectedEntityIds.length > 0) {
    const entity = entities.find(selectedEntityIds[0]);
    if (entity) {
      return { ...entity.position };
    }
  }

  // Check wall
  if (selectedWallId) {
    const wall = config.getWallById(selectedWallId);
    if (wall) {
      return { ...wall.start };
    }
  }

  // Check door
  if (selectedDoorId) {
    const door = config.getDoorById(selectedDoorId);
    if (door) {
      const wall = config.getWallById(door.wallId);
      if (wall) {
        const { normalized, length } = getWallDirection(wall);
        if (length > 0) {
          return {
            x: wall.start.x + normalized.x * door.position,
            y: wall.start.y + normalized.y * door.position,
          };
        }
      }
    }
  }

  return null;
}

/**
 * Gets selection origin from a document the handler already has in its context.
 */
export function getSelectionOriginFromDocument(
  selection: Selection,
  vertices: Vector2[],
  entities: EntityAccess,
  walls: WallSegment[],
  doors: Door[]
): Vector2 | undefined {
  const selectedVertexIndices = getSelectedVertexIndices(selection);
  const selectedEntityIds = entities.selectedIds(selection);
  const selectedWallId = getSelectedWallId(selection);
  const selectedDoorId = getSelectedDoorId(selection);

  // Check vertices first
  if (selectedVertexIndices.length > 0) {
    const firstIndex = selectedVertexIndices[0];
    if (vertices[firstIndex]) {
      return vertices[firstIndex];
    }
  }

  // Check the active module's entities
  if (selectedEntityIds.length > 0) {
    const entity = entities.find(selectedEntityIds[0]);
    if (entity) {
      return entity.position;
    }
  }

  // Check wall - use midpoint
  if (selectedWallId) {
    const wall = walls.find((w) => w.id === selectedWallId);
    if (wall) {
      return {
        x: (wall.start.x + wall.end.x) / 2,
        y: (wall.start.y + wall.end.y) / 2,
      };
    }
  }

  // Check door
  if (selectedDoorId) {
    const door = doors.find((d) => d.id === selectedDoorId);
    if (door) {
      const wall = walls.find((w) => w.id === door.wallId);
      if (wall) {
        const { normalized, length } = getWallDirection(wall);
        if (length > 0) {
          return {
            x: wall.start.x + normalized.x * door.position,
            y: wall.start.y + normalized.y * door.position,
          };
        }
      }
    }
  }

  return undefined;
}
