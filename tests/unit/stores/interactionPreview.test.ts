import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import type { EditorDocument } from '../../../src/floorplan/types/document';
import type { EditorCommand } from '../../../src/floorplan/types/command';
import {
  roomStore,
  committedDocument,
  interaction,
  dispatch,
  openDocument,
  previewCommand,
  commitInteraction,
  cancelInteraction,
} from '../../../src/floorplan/stores/roomStore';
import { sessionStore, history } from '../../../src/floorplan/stores/sessionStore';
import { canUndo as historyCanUndo } from '../../../src/floorplan/types/session';
import { DragManager } from '../../../src/floorplan/interactions/DragManager';
import { WallDragOperation } from '../../../src/floorplan/interactions/operations/WallDragOperation';
import { SnapController } from '../../../src/floorplan/controllers/SnapController';
import { squareRoom } from '../../helpers/documents';

const NO_MODIFIERS = { shiftKey: false, ctrlKey: false, altKey: false };

function countCommittedEmissions(run: () => void): number {
  let count = -1; // svelte stores emit the current value on subscribe
  const stop = committedDocument.subscribe(() => {
    count++;
  });
  run();
  stop();
  return count;
}

function makeDragManager() {
  return new DragManager({
    onSetSnapGuides: () => {},
    onPreviewCommand: (command) => previewCommand(command),
    onCommitCommand: () => commitInteraction(),
    onCancelCommand: () => cancelInteraction(),
  });
}

function makeWallDrag(): WallDragOperation {
  const doc = () => get(roomStore);
  const op = new WallDragOperation(
    {
      snapController: new SnapController(),
      getVertices: () => doc().geometry.boundary.walls.map((w) => ({ ...w.start })),
      getWalls: () => doc().geometry.boundary.walls,
      getWallById: (id) => doc().geometry.boundary.walls.find((w) => w.id === id),
    },
    { onSetSnapGuides: () => {} }
  );
  op.setWallId('wall-1');
  return op;
}

function startWallDrag(manager: DragManager, at = { x: 5, y: 0 }): void {
  manager.startDrag(makeWallDrag(), {
    position: at,
    modifiers: NO_MODIFIERS,
    document: get(roomStore),
    selection: { kind: 'wall', id: 'wall-1' },
  });
}

function wallOne(doc: EditorDocument) {
  return doc.geometry.boundary.walls[0];
}

describe('candidate command previews', () => {
  beforeEach(() => {
    openDocument(squareRoom());
  });

  it('a preview changes the live view and not the committed document', () => {
    const committedBefore = get(committedDocument);

    previewCommand({
      type: 'wall.move',
      wallId: 'wall-1',
      start: { x: 0, y: -3 },
      end: { x: 10, y: -3 },
    });

    expect(wallOne(get(roomStore)).start).toEqual({ x: 0, y: -3 });
    expect(get(committedDocument)).toBe(committedBefore);
    expect(historyCanUndo(get(history))).toBe(false);
  });

  it('commit dispatches the previewed value verbatim and returns to idle', () => {
    const command: EditorCommand = {
      type: 'wall.move',
      wallId: 'wall-1',
      start: { x: 0, y: -3 },
      end: { x: 10, y: -3 },
    };
    previewCommand(command);
    const previewed = get(roomStore);

    expect(commitInteraction()).toBe(true);

    expect(get(interaction)).toEqual({ kind: 'idle' });
    // The last frame the user saw is exactly what was committed
    expect(get(committedDocument)).toEqual(previewed);
    expect(get(roomStore)).toEqual(previewed);
  });

  it('cancel discards the preview and leaves the committed document untouched', () => {
    const committedBefore = get(committedDocument);

    previewCommand({
      type: 'wall.move',
      wallId: 'wall-1',
      start: { x: 0, y: -3 },
      end: { x: 10, y: -3 },
    });
    cancelInteraction();

    expect(get(interaction)).toEqual({ kind: 'idle' });
    expect(get(committedDocument)).toBe(committedBefore);
    expect(get(roomStore)).toBe(committedBefore);
    expect(historyCanUndo(get(history))).toBe(false);
  });

  it('commit with nothing pending is a no-op', () => {
    expect(commitInteraction()).toBe(false);
  });
});

describe('a drag through the DragManager', () => {
  beforeEach(() => {
    openDocument(squareRoom());
  });

  it('previews live and writes the committed document exactly once', () => {
    const manager = makeDragManager();

    const emissions = countCommittedEmissions(() => {
      startWallDrag(manager);
      manager.updateDrag({ x: 5, y: 1 }, NO_MODIFIERS);
      expect(wallOne(get(roomStore)).start).toEqual({ x: 0, y: 1 });
      manager.updateDrag({ x: 5, y: 2 }, NO_MODIFIERS);
      manager.updateDrag({ x: 5, y: 3 }, NO_MODIFIERS);
      expect(wallOne(get(roomStore)).start).toEqual({ x: 0, y: 3 });
      // ...and none of that touched the committed document yet
      expect(wallOne(get(committedDocument)).start).toEqual({ x: 0, y: 0 });
      manager.commitDrag();
    });

    expect(emissions).toBe(1);
    expect(wallOne(get(committedDocument)).start).toEqual({ x: 0, y: 3 });
    expect(get(interaction)).toEqual({ kind: 'idle' });
  });

  it('produces exactly one history entry', () => {
    const manager = makeDragManager();

    startWallDrag(manager);
    for (let i = 1; i <= 20; i++) {
      manager.updateDrag({ x: 5, y: i * 0.1 }, NO_MODIFIERS);
    }
    manager.commitDrag();

    let undos = 0;
    while (sessionStore.undo()) undos++;
    expect(undos).toBe(1);
    expect(wallOne(get(committedDocument)).start).toEqual({ x: 0, y: 0 });
  });

  it('leaves the committed document untouched on cancel', () => {
    const manager = makeDragManager();
    const committedBefore = get(committedDocument);

    const emissions = countCommittedEmissions(() => {
      startWallDrag(manager);
      manager.updateDrag({ x: 5, y: 3 }, NO_MODIFIERS);
      manager.cancelDrag();
    });

    expect(emissions).toBe(0);
    expect(get(committedDocument)).toBe(committedBefore);
    expect(get(roomStore)).toBe(committedBefore);
    expect(historyCanUndo(get(history))).toBe(false);
  });

  it('a drag ending at its origin produces a reference-equal document and no history entry', () => {
    const manager = makeDragManager();
    const committedBefore = get(committedDocument);

    const emissions = countCommittedEmissions(() => {
      startWallDrag(manager);
      manager.updateDrag({ x: 5, y: 3 }, NO_MODIFIERS);
      manager.updateDrag({ x: 5, y: 0 }, NO_MODIFIERS);
      manager.commitDrag();
    });

    expect(emissions).toBe(0);
    expect(get(committedDocument)).toBe(committedBefore);
    expect(historyCanUndo(get(history))).toBe(false);
  });
});

describe('dispatch', () => {
  beforeEach(() => {
    openDocument(squareRoom());
  });

  it('rejects a command that is not serializable data', () => {
    expect(() =>
      dispatch({
        type: 'obstacle.move',
        obstacleId: 'obs-1',
        // a Map is not serializable data
        vertices: new Map() as unknown as [],
      })
    ).toThrow(/not serializable data/);
  });

  it('rejects a payload JSON cannot express', () => {
    expect(() => dispatch({ type: 'space.setCeilingHeight', height: Number.NaN })).toThrow(
      /JSON cannot express/
    );
  });

  it('a value-equal result returns the same document reference', () => {
    const before = get(committedDocument);
    dispatch({ type: 'space.setCeilingHeight', height: before.space.ceilingHeight });
    expect(get(committedDocument)).toBe(before);
  });
});

describe('undo clears a pending preview', () => {
  beforeEach(() => {
    openDocument(squareRoom());
  });

  it('undo discards the candidate command', () => {
    dispatch({ type: 'space.setCeilingHeight', height: 12 });

    previewCommand({
      type: 'wall.move',
      wallId: 'wall-1',
      start: { x: 0, y: -3 },
      end: { x: 10, y: -3 },
    });
    expect(get(interaction).kind).toBe('commandPreview');

    sessionStore.undo();

    expect(get(interaction)).toEqual({ kind: 'idle' });
    expect(get(roomStore)).toBe(get(committedDocument));
  });
});
