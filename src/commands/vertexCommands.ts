import type { CommandHandler, CoreCommand } from '../types/command';
import { withWalls, withDoors, updateVertexInWalls } from './documentEdits';
import { geometryService } from '../services/GeometryService';

type VertexMove = Extract<CoreCommand, { type: 'vertex.move' }>;
type VertexInsert = Extract<CoreCommand, { type: 'vertex.insert' }>;
type VertexDelete = Extract<CoreCommand, { type: 'vertex.delete' }>;

export const vertexMoveHandler: CommandHandler<VertexMove> = {
  label: () => 'Move vertex',
  apply(doc, command) {
    const loop = doc.geometry.boundary;
    if (!loop.isClosed || loop.walls.length === 0) return doc;
    if (command.index < 0 || command.index >= loop.walls.length) return doc;

    const newWalls = [...loop.walls];
    updateVertexInWalls(newWalls, command.index, command.position);
    return withWalls(doc, newWalls);
  },
};

export const vertexInsertHandler: CommandHandler<VertexInsert> = {
  label: () => 'Insert vertex',
  apply(doc, command) {
    const result = geometryService.insertVertexOnWall(
      doc.geometry.boundary,
      command.wallId,
      command.position
    );
    if (result.insertedIndex === null) return doc;
    return withWalls(doc, result.walls);
  },
};

export const vertexDeleteHandler: CommandHandler<VertexDelete> = {
  label: () => 'Delete vertex',
  apply(doc, command) {
    const loop = doc.geometry.boundary;
    const deletedWallId = loop.walls[command.index]?.id;

    const result = geometryService.deleteVertex(loop, command.index);
    if (!result.success) return doc;

    const next = withWalls(doc, result.walls);

    // Doors on the merged-away wall have nothing left to attach to
    if (!deletedWallId) return next;
    const doors = next.geometry.doors.filter((d) => d.wallId !== deletedWallId);
    return doors.length === next.geometry.doors.length ? next : withDoors(next, doors);
  },
};
