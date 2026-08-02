import type { WallSegment } from '../types/geometry';
import type { CommandHandler, CoreCommand } from '../types/command';
import { withWalls, withBoundary } from './documentEdits';
import {
  vectorSubtract,
  vectorNormalize,
  vectorAdd,
  vectorScale,
  distancePointToPoint,
} from '../utils/math';

type WallMove = Extract<CoreCommand, { type: 'wall.move' }>;
type WallSetLength = Extract<CoreCommand, { type: 'wall.setLength' }>;
type RoomClose = Extract<CoreCommand, { type: 'room.close' }>;

export const wallMoveHandler: CommandHandler<WallMove> = {
  label: () => 'Move wall',
  apply(doc, command) {
    const loop = doc.geometry.boundary;
    if (!loop.isClosed || loop.walls.length === 0) return doc;

    const wallIndex = loop.walls.findIndex((w) => w.id === command.wallId);
    if (wallIndex === -1) return doc;

    const numWalls = loop.walls.length;
    const newWalls = [...loop.walls];

    // Update the selected wall (length is unchanged; this is a translation)
    const wall = newWalls[wallIndex];
    newWalls[wallIndex] = {
      ...wall,
      start: { ...command.start },
      end: { ...command.end },
    };

    // The previous wall shares the start vertex
    const prevWallIndex = (wallIndex - 1 + numWalls) % numWalls;
    const prevWall = newWalls[prevWallIndex];
    newWalls[prevWallIndex] = {
      ...prevWall,
      end: { ...command.start },
      length: distancePointToPoint(prevWall.start, command.start),
    };

    // The next wall shares the end vertex
    const nextWallIndex = (wallIndex + 1) % numWalls;
    const nextWall = newWalls[nextWallIndex];
    newWalls[nextWallIndex] = {
      ...nextWall,
      start: { ...command.end },
      length: distancePointToPoint(command.end, nextWall.end),
    };

    return withWalls(doc, newWalls);
  },
};

export const wallSetLengthHandler: CommandHandler<WallSetLength> = {
  label: () => 'Change wall length',
  apply(doc, command) {
    if (command.length <= 0) return doc;

    const loop = doc.geometry.boundary;
    const wallIndex = loop.walls.findIndex((w) => w.id === command.wallId);
    if (wallIndex === -1) return doc;

    const wall = loop.walls[wallIndex];
    const direction = vectorNormalize(vectorSubtract(wall.end, wall.start));
    const newEnd = vectorAdd(wall.start, vectorScale(direction, command.length));

    const updatedWall: WallSegment = {
      ...wall,
      end: newEnd,
      length: command.length,
    };

    const newWalls = [...loop.walls];
    newWalls[wallIndex] = updatedWall;

    // If the room is closed, the adjacent wall's start point follows
    if (loop.isClosed) {
      const nextWallIndex = (wallIndex + 1) % loop.walls.length;
      const nextWall = newWalls[nextWallIndex];

      newWalls[nextWallIndex] = {
        ...nextWall,
        start: { ...newEnd },
        length: distancePointToPoint(newEnd, nextWall.end),
      };
    }

    return withWalls(doc, newWalls);
  },
};

export const roomCloseHandler: CommandHandler<RoomClose> = {
  label: () => 'Close room',
  apply(doc, command) {
    return withBoundary(doc, command.walls, true);
  },
};
