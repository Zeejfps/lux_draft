import type { Vector2, WallSegment } from '../types/geometry';
import type { CommandHandler, CoreCommand } from '../types/command';
import { withObstacles, updateVertexInWalls } from './documentEdits';
import { distancePointToPoint } from '../utils/math';

type ObstacleAdd = Extract<CoreCommand, { type: 'obstacle.add' }>;
type ObstacleMove = Extract<CoreCommand, { type: 'obstacle.move' }>;
type ObstacleVertexMove = Extract<CoreCommand, { type: 'obstacle.vertex.move' }>;
type ObstacleSet = Extract<CoreCommand, { type: 'obstacle.set' }>;
type ObstacleRemove = Extract<CoreCommand, { type: 'obstacle.remove' }>;

export const obstacleAddHandler: CommandHandler<ObstacleAdd> = {
  label: () => 'Add obstacle',
  apply(doc, command) {
    return withObstacles(doc, [...doc.geometry.obstacles, command.obstacle]);
  },
};

/**
 * Absolute positions for every vertex of the obstacle, in index order.
 * Vertex i is the start of wall i and the end of wall i-1.
 */
export const obstacleMoveHandler: CommandHandler<ObstacleMove> = {
  label: () => 'Move obstacle',
  apply(doc, command) {
    const obstacles = doc.geometry.obstacles;
    const obstacleIndex = obstacles.findIndex((o) => o.id === command.obstacleId);
    if (obstacleIndex === -1) return doc;

    const obstacle = obstacles[obstacleIndex];
    const numWalls = obstacle.walls.length;
    if (command.vertices.length !== numWalls) return doc;

    const newWalls: WallSegment[] = [...obstacle.walls];

    for (let index = 0; index < numWalls; index++) {
      const position: Vector2 = command.vertices[index];
      newWalls[index] = { ...newWalls[index], start: { ...position } };
      const prevWallIndex = (index - 1 + numWalls) % numWalls;
      newWalls[prevWallIndex] = { ...newWalls[prevWallIndex], end: { ...position } };
    }

    // Recalculate all wall lengths once every position is final
    for (let i = 0; i < newWalls.length; i++) {
      newWalls[i] = {
        ...newWalls[i],
        length: distancePointToPoint(newWalls[i].start, newWalls[i].end),
      };
    }

    const newObstacles = [...obstacles];
    newObstacles[obstacleIndex] = { ...obstacle, walls: newWalls };
    return withObstacles(doc, newObstacles);
  },
};

export const obstacleVertexMoveHandler: CommandHandler<ObstacleVertexMove> = {
  label: () => 'Move obstacle vertex',
  apply(doc, command) {
    const obstacles = doc.geometry.obstacles;
    const obstacleIndex = obstacles.findIndex((o) => o.id === command.obstacleId);
    if (obstacleIndex === -1) return doc;

    const obstacle = obstacles[obstacleIndex];
    if (command.index < 0 || command.index >= obstacle.walls.length) return doc;

    const newWalls = [...obstacle.walls];
    updateVertexInWalls(newWalls, command.index, command.position);

    const newObstacles = [...obstacles];
    newObstacles[obstacleIndex] = { ...obstacle, walls: newWalls };
    return withObstacles(doc, newObstacles);
  },
};

export const obstacleSetHandler: CommandHandler<ObstacleSet> = {
  label: () => 'Change obstacle',
  apply(doc, command) {
    const obstacles = doc.geometry.obstacles;
    if (!obstacles.some((o) => o.id === command.obstacleId)) return doc;
    return withObstacles(
      doc,
      obstacles.map((o) => (o.id === command.obstacleId ? { ...o, ...command.changes } : o))
    );
  },
};

export const obstacleRemoveHandler: CommandHandler<ObstacleRemove> = {
  label: () => 'Delete obstacle',
  apply(doc, command) {
    const obstacles = doc.geometry.obstacles.filter((o) => o.id !== command.obstacleId);
    return obstacles.length === doc.geometry.obstacles.length ? doc : withObstacles(doc, obstacles);
  },
};
