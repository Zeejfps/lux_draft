/**
 * The verb layer. The point of the phase: there are no sibling stores to clear, so every
 * `select*` is a single write and cross-clearing is a property of the value, not of the order
 * six setters were called in.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import * as selectionStore from '../../../src/floorplan/stores/selectionStore';
import { setActiveTool, activeTool } from '../../../src/floorplan/stores/appStore';
import { sessionStore } from '../../../src/floorplan/stores/sessionStore';
import { asLoadedDocument } from '../../../src/floorplan/types/session';
import {
  getSelectedDoorId,
  getSelectedObstacleId,
  getSelectedObstacleVertexIndices,
  getSelectedVertexIndices,
  getSelectedWallId,
  isEmptySelection,
} from '../../../src/floorplan/types/selection';
import { getSelectedFixtureIds } from '../../../src/modules/lighting/selection';
import { squareRoom } from '../../helpers/documents';
import { fixtureEntityAccess } from '../../helpers/entities';

// The active module's entities, as the activation registry would supply them.
const entities = () => fixtureEntityAccess(() => sessionStore.current().document, read);

const read = () => get(selectionStore.selection);

describe('selectionStore', () => {
  beforeEach(() => {
    sessionStore.open(asLoadedDocument(squareRoom()));
  });

  it('exports no clear-the-sibling helpers', () => {
    // The six `clear*Selection` functions of appStore existed only to keep parallel stores in
    // step. `clearSelection` — select nothing — is the only clear that survives.
    const clears = Object.keys(selectionStore).filter((name) => name.startsWith('clear'));
    expect(clears).toEqual(['clearSelection']);
  });

  it('selecting a wall drops the vertices without clearing anything', () => {
    selectionStore.setVertexSelection([0, 1]);
    expect(getSelectedVertexIndices(read())).toEqual([0, 1]);

    selectionStore.selectWall('wall-1');
    expect(getSelectedWallId(read())).toBe('wall-1');
    expect(getSelectedVertexIndices(read())).toEqual([]);
  });

  it.each([
    ['wall', () => selectionStore.selectWall('wall-1')],
    ['door', () => selectionStore.selectDoor('door-1')],
    ['obstacle', () => selectionStore.selectObstacle('obs-1')],
    ['vertex', () => selectionStore.selectVertex(3)],
    ['fixture', () => selectionStore.selectEntity(entities(), 'light-9')],
  ])('selecting a %s replaces every other kind', (_kind, select) => {
    selectionStore.selectDoor('door-0');
    selectionStore.selectObstacle('obs-0');
    selectionStore.setEntitySelection(entities(), ['light-0']);
    selectionStore.setVertexSelection([7]);

    select();

    const live = [
      getSelectedWallId(read()),
      getSelectedDoorId(read()),
      getSelectedObstacleId(read()),
      getSelectedVertexIndices(read()).length > 0 ? 'vertex' : null,
      getSelectedFixtureIds(read()).length > 0 ? 'fixture' : null,
    ].filter((value) => value !== null);
    expect(live).toHaveLength(1);
  });

  it('shift-click toggles within a kind', () => {
    selectionStore.selectVertex(1);
    selectionStore.selectVertex(2, true);
    expect(getSelectedVertexIndices(read())).toEqual([1, 2]);
    selectionStore.selectVertex(1, true);
    expect(getSelectedVertexIndices(read())).toEqual([2]);
    selectionStore.selectVertex(2, true);
    expect(isEmptySelection(read())).toBe(true);
  });

  it('an obstacle vertex keeps its obstacle selected, and falls back to it when emptied', () => {
    selectionStore.selectObstacleVertex('obs-1', 0);
    expect(getSelectedObstacleId(read())).toBe('obs-1');
    expect(getSelectedObstacleVertexIndices(read())).toEqual([0]);

    selectionStore.selectObstacleVertex('obs-1', 0, true);
    expect(read()).toEqual({ kind: 'obstacle', id: 'obs-1' });
  });

  it('selecting a vertex of another obstacle does not carry the old indices over', () => {
    selectionStore.selectObstacleVertex('obs-1', 0);
    selectionStore.selectObstacleVertex('obs-2', 3, true);
    expect(getSelectedObstacleId(read())).toBe('obs-2');
    expect(getSelectedObstacleVertexIndices(read())).toEqual([3]);
  });

  it('box selection is the one producer of a heterogeneous selection', () => {
    selectionStore.selectInBox(entities(), [0, 1], ['light-1'], false);
    expect(read().kind).toBe('multi');
    expect(getSelectedVertexIndices(read())).toEqual([0, 1]);
    expect(getSelectedFixtureIds(read())).toEqual(['light-1']);
  });

  it('a box that catches only vertices leaves the fixtures alone', () => {
    selectionStore.selectInBox(entities(), [0], ['light-1'], false);
    selectionStore.selectInBox(entities(), [2], [], false);
    expect(getSelectedVertexIndices(read())).toEqual([2]);
    expect(getSelectedFixtureIds(read())).toEqual(['light-1']);
  });

  it('a shift box adds to what is already selected', () => {
    selectionStore.selectInBox(entities(), [0], ['light-1'], false);
    selectionStore.selectInBox(entities(), [1], ['light-2'], true);
    expect(getSelectedVertexIndices(read())).toEqual([0, 1]);
    expect(getSelectedFixtureIds(read())).toEqual(['light-1', 'light-2']);
  });

  it('retainBoxCandidates keeps vertices and fixtures and drops the rest', () => {
    selectionStore.selectInBox(entities(), [0], ['light-1'], false);
    selectionStore.select({ kind: 'wall', id: 'wall-1' });
    selectionStore.retainBoxCandidates(entities());
    expect(isEmptySelection(read())).toBe(true);

    selectionStore.selectInBox(entities(), [0], ['light-1'], false);
    selectionStore.retainBoxCandidates(entities());
    expect(getSelectedVertexIndices(read())).toEqual([0]);
    expect(getSelectedFixtureIds(read())).toEqual(['light-1']);
  });

  it('switching tools clears the selection', () => {
    selectionStore.selectWall('wall-1');
    setActiveTool('draw');
    expect(isEmptySelection(read())).toBe(true);
    expect(get(activeTool)).toBe('draw');
    setActiveTool('select');
  });

  it('opening a document clears the selection', () => {
    selectionStore.selectWall('wall-1');
    sessionStore.open(asLoadedDocument(squareRoom()));
    expect(isEmptySelection(read())).toBe(true);
  });

  it('re-selecting the same thing is a no-op — no emission', () => {
    selectionStore.selectWall('wall-1');
    let emissions = -1;
    const stop = selectionStore.selection.subscribe(() => {
      emissions++;
    });
    selectionStore.selectWall('wall-1');
    stop();
    expect(emissions).toBe(0);
  });
});
