import type { Vector2, WallSegment } from '../types/geometry';
import type { WallLoop } from '../types/document';
import { distancePointToPoint } from '../utils/math';
import { generateId } from '../utils/id';

/**
 * Service for geometry operations on a wall loop.
 * Pure functions — they take and return plain values and touch no store.
 */
export class GeometryService {
  /**
   * Insert a vertex on a wall and return the new walls plus the inserted index.
   */
  insertVertexOnWall(
    loop: WallLoop,
    wallId: string,
    position: Vector2
  ): { walls: WallSegment[]; insertedIndex: number | null } {
    if (!loop.isClosed || loop.walls.length === 0) {
      return { walls: loop.walls, insertedIndex: null };
    }

    const wallIndex = loop.walls.findIndex((w) => w.id === wallId);
    if (wallIndex === -1) {
      return { walls: loop.walls, insertedIndex: null };
    }

    const wall = loop.walls[wallIndex];

    // Create two new walls from the split
    const newWall1: WallSegment = {
      id: generateId(),
      start: { ...wall.start },
      end: { ...position },
      length: distancePointToPoint(wall.start, position),
    };

    const newWall2: WallSegment = {
      id: generateId(),
      start: { ...position },
      end: { ...wall.end },
      length: distancePointToPoint(position, wall.end),
    };

    // Replace the old wall with two new walls
    const newWalls = [
      ...loop.walls.slice(0, wallIndex),
      newWall1,
      newWall2,
      ...loop.walls.slice(wallIndex + 1),
    ];

    // The new vertex is at index wallIndex + 1 (start of newWall2)
    return { walls: newWalls, insertedIndex: wallIndex + 1 };
  }

  /**
   * Delete a vertex, merging the two walls that meet there.
   */
  deleteVertex(loop: WallLoop, vertexIndex: number): { walls: WallSegment[]; success: boolean } {
    if (!loop.isClosed || loop.walls.length <= 3) {
      return { walls: loop.walls, success: false }; // Need at least 3 vertices for a polygon
    }

    const numWalls = loop.walls.length;
    if (vertexIndex < 0 || vertexIndex >= numWalls) {
      return { walls: loop.walls, success: false };
    }

    // The vertex at index i is the start of wall[i] and end of wall[i-1]
    // Deleting it means merging wall[i-1] and wall[i] into one wall
    const prevWallIndex = (vertexIndex - 1 + numWalls) % numWalls;
    const currentWallIndex = vertexIndex;

    const prevWall = loop.walls[prevWallIndex];
    const currentWall = loop.walls[currentWallIndex];

    // Create merged wall (from prevWall.start to currentWall.end)
    const mergedWall: WallSegment = {
      id: prevWall.id, // Keep the previous wall's id
      start: { ...prevWall.start },
      end: { ...currentWall.end },
      length: distancePointToPoint(prevWall.start, currentWall.end),
    };

    // Build new walls array
    const newWalls: WallSegment[] = [];
    for (let i = 0; i < numWalls; i++) {
      if (i === prevWallIndex) {
        newWalls.push(mergedWall);
      } else if (i === currentWallIndex) {
        // Skip this wall, it's been merged
      } else {
        newWalls.push(loop.walls[i]);
      }
    }

    return { walls: newWalls, success: true };
  }
}

// Singleton instance for convenience
export const geometryService = new GeometryService();
