import type { Vector2, WallSegment, Door } from '../../types';
import type { EntityAccess } from '../../types/entity';
import type { SnapController } from '../../controllers/SnapController';

/**
 * Base configuration for accessing room state.
 * Used by operations and handlers that need to read current room data.
 */
export interface RoomStateAccessor {
  getVertices: () => Vector2[];
  getWalls: () => WallSegment[];
}

/**
 * Extended accessor with the active module's entities.
 *
 * Core drags move room vertices and module entities in one gesture, so every drag config needs
 * a handle on them. It is a getter rather than a value because activation can change between
 * two frames of the same session.
 */
export interface RoomStateWithEntities extends RoomStateAccessor {
  getEntities: () => EntityAccess;
}

/**
 * Extended room state accessor with wall lookup.
 */
export interface RoomStateWithWallLookup extends RoomStateAccessor {
  getWallById: (id: string) => WallSegment | undefined;
}

/**
 * Extended room state accessor with door access.
 */
export interface RoomStateWithDoors extends RoomStateWithWallLookup {
  getDoors: () => Door[];
  getDoorById: (id: string) => Door | undefined;
  getDoorsByWallId: (wallId: string) => Door[];
}

/**
 * Base configuration for snap-enabled operations.
 */
export interface SnapConfig {
  snapController: SnapController;
}

/**
 * Configuration for grid snap operations.
 */
export interface GridSnapEnabledConfig extends SnapConfig {
  getGridSnapEnabled: () => boolean;
  getGridSize: () => number;
}

/**
 * Combined config for operations that need room state and snapping.
 */
export interface BaseDragConfig extends GridSnapEnabledConfig, RoomStateWithEntities {
  isRoomClosed: () => boolean;
}
