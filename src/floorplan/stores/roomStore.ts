import { derived } from 'svelte/store';
import type { WallSegment, Vector2, Door, Obstacle } from '../types/geometry';
import type { EditorDocument } from '../types/document';
import type { EditorCommand, DoorChanges, ObstacleChanges } from '../types/command';
import type { LoadedDocument } from '../types/session';
import { createEmptyDocument } from '../types/document';
import { asLoadedDocument } from '../types/session';
import { sessionStore, roomStore } from './sessionStore';
import { geometryService } from '../services/GeometryService';

// ============================================
// Store topology
// ============================================
//
// One `Session` value behind `sessionStore` (invariant 1); `roomStore` and
// `committedDocument` are narrow derived views over it, defined in `sessionStore.ts`.
//
// `roomStore` keeps its old name and its old *live* meaning — during a gesture it shows the
// preview, exactly as writing mid-drag used to. `committedDocument` is what history, autosave,
// export and share read; it changes only when a command is dispatched, a document is opened,
// or history moves.
//
// This file is now the verb layer: read helpers, room-shaped derived views, and one thin
// command producer per call site.

export { roomStore, committedDocument, interaction } from './sessionStore';

// ============================================
// The write path
// ============================================

/** The only way to edit the document (invariant 2). One command, one history entry. */
export function dispatch(command: EditorCommand): void {
  sessionStore.dispatch(command);
}

/**
 * Replace the whole session from a decoded load (invariant 9). **Every** entry point —
 * local storage, file import, share link — ends here with a real `LoadedDocument`, carrying
 * the quarantined blobs and warnings decode produced.
 */
export function openLoaded(loaded: LoadedDocument): void {
  sessionStore.open(loaded);
}

/** A document nothing decoded: a new project. Not a command, not undoable. */
export function openDocument(doc: EditorDocument): void {
  sessionStore.open(asLoadedDocument(doc));
}

/** Show a candidate command. Writes nothing to the committed document. */
export function previewCommand(command: EditorCommand): void {
  sessionStore.setInteraction({ kind: 'commandPreview', command });
}

/** Discard the candidate command. The committed document is untouched. */
export function cancelInteraction(): void {
  sessionStore.cancelInteraction();
}

/**
 * Commit the candidate command: dispatch that exact value and return to idle, in one emission.
 * Returns true when something was pending.
 */
export function commitInteraction(): boolean {
  return sessionStore.finishInteraction();
}

// ============================================
// Derived views
// ============================================

export const canPlaceLights = derived(roomStore, ($room) => $room.geometry.boundary.isClosed);
export const canPlaceDoors = derived(roomStore, ($room) => $room.geometry.boundary.isClosed);
export const canDrawObstacles = derived(roomStore, ($room) => $room.geometry.boundary.isClosed);

export const roomBounds = derived(roomStore, ($room) => {
  const walls = $room.geometry.boundary.walls;
  if (walls.length === 0) {
    return { minX: -10, minY: -10, maxX: 10, maxY: 10 };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const wall of walls) {
    minX = Math.min(minX, wall.start.x, wall.end.x);
    minY = Math.min(minY, wall.start.y, wall.end.y);
    maxX = Math.max(maxX, wall.start.x, wall.end.x);
    maxY = Math.max(maxY, wall.start.y, wall.end.y);
  }

  const padding = 2;
  return {
    minX: minX - padding,
    minY: minY - padding,
    maxX: maxX + padding,
    maxY: maxY + padding,
  };
});

// ============================================
// Read helpers
// ============================================

export function getVertices(doc: EditorDocument): Vector2[] {
  return doc.geometry.boundary.walls.map((w) => w.start);
}

export function getDoorsByWallId(doc: EditorDocument, wallId: string): Door[] {
  return doc.geometry.doors.filter((d) => d.wallId === wallId);
}

// ============================================
// Command producers
//
// Thin wrappers so call sites keep reading like verbs. Each one is exactly one dispatch.
// ============================================

export function resetRoom(): void {
  openDocument(createEmptyDocument());
}

export function closeRoom(walls: WallSegment[]): void {
  dispatch({ type: 'room.close', walls });
}

export function updateWallLength(wallId: string, newLength: number): void {
  if (newLength <= 0) return;
  dispatch({ type: 'wall.setLength', wallId, length: newLength });
}

export function updateVertexPosition(vertexIndex: number, newPosition: Vector2): void {
  dispatch({ type: 'vertex.move', index: vertexIndex, position: newPosition });
}

/** Returns the index of the inserted vertex, or null when the insert was rejected. */
export function insertVertexOnWall(wallId: string, position: Vector2): number | null {
  const doc = sessionStore.current().document;
  const { insertedIndex } = geometryService.insertVertexOnWall(
    doc.geometry.boundary,
    wallId,
    position
  );
  if (insertedIndex === null) return null;

  dispatch({ type: 'vertex.insert', wallId, position });
  return insertedIndex;
}

export function deleteVertex(vertexIndex: number): boolean {
  const doc = sessionStore.current().document;
  const { success } = geometryService.deleteVertex(doc.geometry.boundary, vertexIndex);
  if (!success) return false;

  dispatch({ type: 'vertex.delete', index: vertexIndex });
  return true;
}

// --- doors ---

export function addDoor(door: Door): void {
  dispatch({ type: 'door.add', door });
}

export function updateDoor(doorId: string, changes: DoorChanges): void {
  dispatch({ type: 'door.set', doorId, changes });
}

export function removeDoor(doorId: string): void {
  dispatch({ type: 'door.remove', doorId });
}

// --- obstacles ---

export function addObstacle(obstacle: Obstacle): void {
  dispatch({ type: 'obstacle.add', obstacle });
}

export function updateObstacle(id: string, changes: ObstacleChanges): void {
  dispatch({ type: 'obstacle.set', obstacleId: id, changes });
}

export function removeObstacle(id: string): void {
  dispatch({ type: 'obstacle.remove', obstacleId: id });
}
