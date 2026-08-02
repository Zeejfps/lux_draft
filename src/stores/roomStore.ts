import { writable, derived, get } from 'svelte/store';
import type { WallSegment, Vector2, Door, Obstacle } from '../types/geometry';
import type { EditorDocument } from '../types/document';
import type { EditorCommand, DoorChanges, ObstacleChanges } from '../types/command';
import type { Interaction } from '../types/interaction';
import { createEmptyDocument } from '../types/document';
import { IDLE_INTERACTION } from '../types/interaction';
import {
  applyCommand,
  previewDocument,
  assertCommandIsSerializable,
  valueEqual,
} from '../commands';
import { geometryService } from '../services/GeometryService';

// ============================================
// Store topology
// ============================================
//
// `committedRoom` is what history, autosave, export and share read: it changes only when a
// command is dispatched, a document is opened, or history moves. `interaction` holds the
// candidate command the user is aiming. `roomStore` keeps its old name and its old *live*
// meaning — during a gesture it shows the preview, exactly as writing mid-drag used to.
//
// Phase 1b replaces all three with a single `Session` value and `reduceSession`.

/** Committed document. Never contains a preview. */
export const committedRoom = writable<EditorDocument>(createEmptyDocument());

/** Ephemeral gesture state. Not persisted, not undoable. */
export const interaction = writable<Interaction>(IDLE_INTERACTION);

/** Live view: committed document with the candidate command applied. What the editor renders. */
export const roomStore = derived([committedRoom, interaction], ([$doc, $interaction]) =>
  previewDocument($doc, $interaction)
);

// ============================================
// The write path
// ============================================

/**
 * The only way to edit the document (invariant 2).
 *
 * A command whose result is value-equal to the current document keeps the *same reference* and
 * the store is never written, so it does not emit and no history entry appears. That guarantee
 * lives here rather than in `historyStore`'s stringify diff, because phase 1b deletes that diff.
 *
 * (Svelte's `writable` emits on every `set` of an object value, reference-equal or not, so the
 * no-op has to skip the write rather than return the old reference from `update`.)
 */
export function dispatch(command: EditorCommand): void {
  if (import.meta.env.DEV) {
    assertCommandIsSerializable(command);
  }
  const doc = get(committedRoom);
  const next = applyCommand(doc, command);
  if (valueEqual(next, doc)) return;
  committedRoom.set(next);
}

/** Replace the whole document — load, import, share link, reset. Not a command, not undoable. */
export function openDocument(doc: EditorDocument): void {
  interaction.set(IDLE_INTERACTION);
  committedRoom.set(doc);
}

/** Show a candidate command. Writes nothing to the committed document. */
export function previewCommand(command: EditorCommand): void {
  interaction.set({ kind: 'commandPreview', command });
}

/** Discard the candidate command. The committed document is untouched. */
export function cancelInteraction(): void {
  if (get(interaction).kind !== 'idle') {
    interaction.set(IDLE_INTERACTION);
  }
}

/**
 * Commit the candidate command: dispatch that exact value and return to idle.
 * Returns true when something was pending.
 */
export function commitInteraction(): boolean {
  const current = get(interaction);
  if (current.kind !== 'commandPreview') return false;

  interaction.set(IDLE_INTERACTION);
  dispatch(current.command);
  return true;
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
  const doc = get(committedRoom);
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
  const doc = get(committedRoom);
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

// --- lights (legacy; becomes `lighting.*` in phase 3b) ---

export function addLight(light: import('../types/lighting').LightFixture): void {
  dispatch({ type: 'light.add', light });
}

export function removeLights(ids: Iterable<string>): void {
  const commands: EditorCommand[] = [];
  for (const id of ids) commands.push({ type: 'light.remove', lightId: id });
  if (commands.length === 0) return;
  if (commands.length === 1) {
    dispatch(commands[0]);
    return;
  }
  dispatch({ type: 'compound', label: 'Delete lights', commands });
}
