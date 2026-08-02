import type { EditorDocument } from '../../src/types/document';
import type { WallSegment, Vector2, Door, Obstacle } from '../../src/types/geometry';
import type { LightFixture } from '../../src/types/lighting';
import { createEmptyDocument } from '../../src/types/document';

export interface DocumentParts {
  walls?: WallSegment[];
  isClosed?: boolean;
  doors?: Door[];
  obstacles?: Obstacle[];
  lights?: LightFixture[];
  ceilingHeight?: number;
}

export function makeDocument(parts: DocumentParts = {}): EditorDocument {
  const doc = createEmptyDocument();
  return {
    geometry: {
      boundary: {
        walls: parts.walls ?? doc.geometry.boundary.walls,
        isClosed: parts.isClosed ?? doc.geometry.boundary.isClosed,
      },
      doors: parts.doors ?? [],
      obstacles: parts.obstacles ?? [],
    },
    space: { ceilingHeight: parts.ceilingHeight ?? doc.space.ceilingHeight },
    lights: parts.lights ?? [],
  };
}

/** Walls of a closed rectangle with its lower-left corner at the origin. */
export function rectWalls(width: number, height: number, prefix = 'wall'): WallSegment[] {
  const corners: Vector2[] = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
  return corners.map((start, i) => {
    const end = corners[(i + 1) % corners.length];
    return {
      id: `${prefix}-${i + 1}`,
      start: { ...start },
      end: { ...end },
      length: Math.hypot(end.x - start.x, end.y - start.y),
    };
  });
}

/** A closed 10x10 room. */
export function squareRoom(parts: DocumentParts = {}): EditorDocument {
  return makeDocument({ walls: rectWalls(10, 10), isClosed: true, ...parts });
}

export function makeObstacle(id: string, origin: Vector2, size: number): Obstacle {
  const walls = rectWalls(size, size, `${id}-w`).map((w) => ({
    ...w,
    start: { x: w.start.x + origin.x, y: w.start.y + origin.y },
    end: { x: w.end.x + origin.x, y: w.end.y + origin.y },
  }));
  return { id, walls, height: 3 };
}

export function makeLight(id: string, position: Vector2): LightFixture {
  return { id, position, properties: { lumen: 800, beamAngle: 60, warmth: 2700 } };
}

export function makeDoor(id: string, wallId: string, position: number): Door {
  return { id, wallId, position, width: 3, swingDirection: 'left', swingSide: 'inside' };
}

export function obstacleVertices(doc: EditorDocument, obstacleId: string): Vector2[] {
  const obstacle = doc.geometry.obstacles.find((o) => o.id === obstacleId);
  if (!obstacle) throw new Error(`no obstacle ${obstacleId}`);
  return obstacle.walls.map((w) => ({ ...w.start }));
}
