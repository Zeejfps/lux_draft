import { sessionStore, selection } from './sessionStore';
import {
  combineSelection,
  getSelectedObstacleId,
  getSelectedObstacleVertexIndices,
  getSelectedVertexIndices,
  isEmptySelection,
  NO_SELECTION,
  toggleMember,
  type Selection,
} from '../types/selection';
import { fixtureSelectionOf, getSelectedFixtureIds } from '../../modules/lighting/selection';

/**
 * The verb layer over `Session.selection` — one value, so **no function here clears a
 * sibling**. Selecting a wall drops whatever was selected because the value is replaced,
 * not because six stores were reset in the right order.
 *
 * The read side is the narrow `selection` store, re-exported here so components have one
 * import for both halves.
 */
export { selection };

function current(): Selection {
  return sessionStore.current().selection;
}

export function select(next: Selection): void {
  sessionStore.select(next);
}

export function clearSelection(): void {
  sessionStore.select(NO_SELECTION);
}

export function hasAnySelection(): boolean {
  return !isEmptySelection(current());
}

// ============================================
// Core entities
// ============================================

export function selectWall(id: string): void {
  select({ kind: 'wall', id });
}

export function selectDoor(id: string): void {
  select({ kind: 'door', id });
}

export function selectObstacle(id: string): void {
  select({ kind: 'obstacle', id });
}

export function selectVertex(index: number, addToSelection: boolean = false): void {
  setVertexSelection(toggleMember(getSelectedVertexIndices(current()), index, addToSelection));
}

export function setVertexSelection(indices: readonly number[]): void {
  select(indices.length > 0 ? { kind: 'vertex', indices: [...indices] } : NO_SELECTION);
}

/**
 * An obstacle vertex selection carries its obstacle, so selecting one keeps the obstacle
 * selected without a second store to keep in step. Toggling the last vertex off falls back
 * to the obstacle itself, which is what clearing the vertex set used to leave behind.
 */
export function selectObstacleVertex(
  obstacleId: string,
  vertexIndex: number,
  addToSelection: boolean = false
): void {
  const previous = current();
  const sameObstacle = getSelectedObstacleId(previous) === obstacleId;
  const existing = sameObstacle ? getSelectedObstacleVertexIndices(previous) : [];
  setObstacleVertexSelection(obstacleId, toggleMember(existing, vertexIndex, addToSelection));
}

export function setObstacleVertexSelection(obstacleId: string, indices: readonly number[]): void {
  select(
    indices.length > 0
      ? { kind: 'obstacleVertex', obstacleId, indices: [...indices] }
      : { kind: 'obstacle', id: obstacleId }
  );
}

// ============================================
// Lighting fixtures (a module selection — see lighting/selection.ts)
// ============================================

export function selectFixture(id: string, addToSelection: boolean = false): void {
  setFixtureSelection(toggleMember(getSelectedFixtureIds(current()), id, addToSelection));
}

export function setFixtureSelection(ids: readonly string[]): void {
  select(fixtureSelectionOf(ids));
}

// ============================================
// Box selection
// ============================================

function union<T>(existing: readonly T[], added: readonly T[]): T[] {
  const next = [...existing];
  for (const value of added) {
    if (!next.includes(value)) next.push(value);
  }
  return next;
}

/**
 * Box selection over the room: vertices and fixtures together, which is the one place a
 * heterogeneous selection is produced. A kind with nothing in the box is left alone, matching
 * the previous per-store behavior.
 */
export function selectInBox(
  vertexIndices: readonly number[],
  fixtureIds: readonly string[],
  addToSelection: boolean
): void {
  const previous = current();
  const previousVertices = getSelectedVertexIndices(previous);
  const previousFixtures = getSelectedFixtureIds(previous);

  const vertices =
    vertexIndices.length === 0
      ? previousVertices
      : addToSelection
        ? union(previousVertices, vertexIndices)
        : vertexIndices;
  const fixtures =
    fixtureIds.length === 0
      ? previousFixtures
      : addToSelection
        ? union(previousFixtures, fixtureIds)
        : fixtureIds;

  select(
    combineSelection([
      vertices.length > 0 ? { kind: 'vertex', indices: [...vertices] } : NO_SELECTION,
      fixtureSelectionOf(fixtures),
    ])
  );
}

/**
 * Starting a shift+box drag in empty space: keep the parts a box can extend (vertices and
 * fixtures) and drop the rest. Previously six clears in the right order.
 */
export function retainBoxCandidates(): void {
  const previous = current();
  select(
    combineSelection([
      getSelectedVertexIndices(previous).length > 0
        ? { kind: 'vertex', indices: [...getSelectedVertexIndices(previous)] }
        : NO_SELECTION,
      fixtureSelectionOf(getSelectedFixtureIds(previous)),
    ])
  );
}

/** Box selection inside an obstacle: only that obstacle's vertices are candidates. */
export function selectObstacleVerticesInBox(
  obstacleId: string,
  indices: readonly number[],
  addToSelection: boolean
): void {
  const existing =
    getSelectedObstacleId(current()) === obstacleId
      ? getSelectedObstacleVertexIndices(current())
      : [];
  setObstacleVertexSelection(obstacleId, addToSelection ? union(existing, indices) : [...indices]);
}
