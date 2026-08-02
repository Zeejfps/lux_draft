import type { Door, Obstacle, Vector2, WallSegment } from '../types/geometry';
import type { DisplayPreferences, UnitFormat } from '../types/state';
import type { FloorplanGeometry, SpaceMetadata } from '../types/document';
import { DEFAULT_CEILING_HEIGHT } from '../types/document';
import { DEFAULT_DISPLAY_PREFERENCES, migrateLightRadiusVisibility } from '../types/state';
import { ValidationError } from './ValidationError';

/**
 * Validation of the shared drawing. This is the **only** thing that rejects a document
 * (invariant 8): geometry is the asset both modules hang off, so a broken polygon is fatal
 * while a broken module slice is quarantined.
 *
 * The rules are the ones `jsonImport.validateRoomState` has always applied, restated against
 * the nested shape. `jsonImport` keeps its own copy until phase 3b routes every entry point
 * through `documentCodec` and deletes it.
 */

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readVector2(data: unknown, field: string): Vector2 {
  if (!isRecord(data)) throw new ValidationError(`Invalid ${field}: expected an object`);
  if (typeof data.x !== 'number') throw new ValidationError(`Invalid ${field}.x: must be a number`);
  if (typeof data.y !== 'number') throw new ValidationError(`Invalid ${field}.y: must be a number`);
  return { x: data.x, y: data.y };
}

function readWallSegment(data: unknown, field: string): WallSegment {
  if (!isRecord(data)) throw new ValidationError(`Invalid ${field}: expected an object`);
  if (typeof data.id !== 'string')
    throw new ValidationError(`Invalid ${field}.id: must be a string`);
  if (typeof data.length !== 'number' || data.length < 0) {
    throw new ValidationError(`Invalid ${field}.length: must be a non-negative number`);
  }
  return {
    id: data.id,
    start: readVector2(data.start, `${field}.start`),
    end: readVector2(data.end, `${field}.end`),
    length: data.length,
  };
}

function readDoor(data: unknown, field: string): Door {
  if (!isRecord(data)) throw new ValidationError(`Invalid ${field}: expected an object`);
  if (typeof data.id !== 'string')
    throw new ValidationError(`Invalid ${field}.id: must be a string`);
  if (typeof data.wallId !== 'string') {
    throw new ValidationError(`Invalid ${field}.wallId: must be a string`);
  }
  if (typeof data.position !== 'number' || data.position < 0) {
    throw new ValidationError(`Invalid ${field}.position: must be a non-negative number`);
  }
  if (typeof data.width !== 'number' || data.width <= 0) {
    throw new ValidationError(`Invalid ${field}.width: must be a positive number`);
  }
  if (data.swingDirection !== 'left' && data.swingDirection !== 'right') {
    throw new ValidationError(`Invalid ${field}.swingDirection: must be "left" or "right"`);
  }
  if (data.swingSide !== undefined && data.swingSide !== 'inside' && data.swingSide !== 'outside') {
    throw new ValidationError(`Invalid ${field}.swingSide: must be "inside" or "outside"`);
  }
  return {
    id: data.id,
    wallId: data.wallId,
    position: data.position,
    width: data.width,
    swingDirection: data.swingDirection,
    // Migration: documents written before swing sides existed open inward.
    swingSide: data.swingSide ?? 'inside',
  };
}

function readObstacle(data: unknown, field: string): Obstacle {
  if (!isRecord(data)) throw new ValidationError(`Invalid ${field}: expected an object`);
  if (typeof data.id !== 'string')
    throw new ValidationError(`Invalid ${field}.id: must be a string`);
  if (typeof data.height !== 'number' || data.height <= 0) {
    throw new ValidationError(`Invalid ${field}.height: must be a positive number`);
  }
  if (!Array.isArray(data.walls)) {
    throw new ValidationError(`Invalid ${field}.walls: must be an array`);
  }
  return {
    id: data.id,
    height: data.height,
    walls: data.walls.map((w, i) => readWallSegment(w, `${field}.walls[${i}]`)),
  };
}

export function validateGeometry(raw: unknown): FloorplanGeometry {
  if (!isRecord(raw)) throw new ValidationError('Invalid geometry: expected an object');

  const boundary = raw.boundary;
  if (!isRecord(boundary))
    throw new ValidationError('Invalid geometry.boundary: expected an object');
  if (!Array.isArray(boundary.walls)) {
    throw new ValidationError('Invalid walls: must be an array');
  }
  if (typeof boundary.isClosed !== 'boolean') {
    throw new ValidationError('Invalid isClosed: must be a boolean');
  }

  const doors = raw.doors ?? [];
  if (!Array.isArray(doors)) throw new ValidationError('Invalid doors: must be an array');
  const obstacles = raw.obstacles ?? [];
  if (!Array.isArray(obstacles)) throw new ValidationError('Invalid obstacles: must be an array');

  return {
    boundary: {
      walls: boundary.walls.map((w, i) => readWallSegment(w, `walls[${i}]`)),
      isClosed: boundary.isClosed,
    },
    doors: doors.map((d, i) => readDoor(d, `doors[${i}]`)),
    obstacles: obstacles.map((o, i) => readObstacle(o, `obstacles[${i}]`)),
  };
}

export function validateSpace(raw: unknown): SpaceMetadata {
  if (raw === undefined) return { ceilingHeight: DEFAULT_CEILING_HEIGHT };
  if (!isRecord(raw)) throw new ValidationError('Invalid space: expected an object');
  if (typeof raw.ceilingHeight !== 'number' || raw.ceilingHeight <= 0) {
    throw new ValidationError('Invalid ceilingHeight: must be a positive number');
  }
  return { ceilingHeight: raw.ceilingHeight };
}

/**
 * Display preferences are a document field but not geometry: a bad one falls back to the
 * default rather than rejecting the drawing.
 */
export function validateDisplayPreferences(raw: unknown): DisplayPreferences | undefined {
  if (!isRecord(raw)) return undefined;
  const unitFormat: UnitFormat =
    raw.unitFormat === 'inches' || raw.unitFormat === 'feet-inches'
      ? raw.unitFormat
      : DEFAULT_DISPLAY_PREFERENCES.unitFormat;
  return {
    useFractions:
      typeof raw.useFractions === 'boolean'
        ? raw.useFractions
        : DEFAULT_DISPLAY_PREFERENCES.useFractions,
    snapThreshold:
      typeof raw.snapThreshold === 'number' && raw.snapThreshold >= 0
        ? raw.snapThreshold
        : DEFAULT_DISPLAY_PREFERENCES.snapThreshold,
    unitFormat,
    gridSnapEnabled:
      typeof raw.gridSnapEnabled === 'boolean'
        ? raw.gridSnapEnabled
        : DEFAULT_DISPLAY_PREFERENCES.gridSnapEnabled,
    gridSize:
      typeof raw.gridSize === 'number' && raw.gridSize > 0
        ? raw.gridSize
        : DEFAULT_DISPLAY_PREFERENCES.gridSize,
    lightRadiusVisibility: migrateLightRadiusVisibility(raw.lightRadiusVisibility),
  };
}
