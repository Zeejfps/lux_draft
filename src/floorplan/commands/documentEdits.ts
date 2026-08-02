import type { WallSegment, Door, Obstacle, Vector2 } from '../types/geometry';
import type { EditorDocument } from '../types/document';
import { distancePointToPoint } from '../utils/math';

/** Replace the boundary walls, preserving everything else. */
export function withWalls(doc: EditorDocument, walls: WallSegment[]): EditorDocument {
  return {
    ...doc,
    geometry: {
      ...doc.geometry,
      boundary: { ...doc.geometry.boundary, walls },
    },
  };
}

/** Replace the whole boundary loop. */
export function withBoundary(
  doc: EditorDocument,
  walls: WallSegment[],
  isClosed: boolean
): EditorDocument {
  return { ...doc, geometry: { ...doc.geometry, boundary: { walls, isClosed } } };
}

export function withDoors(doc: EditorDocument, doors: Door[]): EditorDocument {
  return { ...doc, geometry: { ...doc.geometry, doors } };
}

export function withObstacles(doc: EditorDocument, obstacles: Obstacle[]): EditorDocument {
  return { ...doc, geometry: { ...doc.geometry, obstacles } };
}

/**
 * Update a vertex in a closed wall loop: sets wall[vertexIndex].start and wall[prevIndex].end,
 * recalculating lengths for both affected walls. Mutates the provided walls array in place —
 * callers pass a copy they own.
 */
export function updateVertexInWalls(
  walls: WallSegment[],
  vertexIndex: number,
  newPosition: Vector2
): void {
  const numWalls = walls.length;

  const currentWall = walls[vertexIndex];
  walls[vertexIndex] = {
    ...currentWall,
    start: { ...newPosition },
    length: distancePointToPoint(newPosition, currentWall.end),
  };

  const prevWallIndex = (vertexIndex - 1 + numWalls) % numWalls;
  const prevWall = walls[prevWallIndex];
  walls[prevWallIndex] = {
    ...prevWall,
    end: { ...newPosition },
    length: distancePointToPoint(prevWall.start, newPosition),
  };
}
