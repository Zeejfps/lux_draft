/**
 * `reduceSession` as a pure table: no store, no Svelte, no DOM. Every session transition is
 * one action, so the whole state machine is testable as a function.
 */
import { describe, it, expect } from 'vitest';
import type { Session } from '../../../src/types/session';
import type { EditorCommand } from '../../../src/types/command';
import {
  asLoadedDocument,
  canRedo,
  canUndo,
  createEmptySession,
  redoLabel,
  undoLabel,
} from '../../../src/types/session';
import { reduceSession, MAX_HISTORY, type SessionAction } from '../../../src/stores/reduceSession';
import { makeDocument, makeLight, rectWalls, squareRoom } from '../../helpers/documents';

const setCeiling = (height: number): EditorCommand => ({ type: 'space.setCeilingHeight', height });
const moveWall = (y: number): EditorCommand => ({
  type: 'wall.move',
  wallId: 'wall-1',
  start: { x: 0, y },
  end: { x: 10, y },
});

function sessionWith(document = makeDocument({ ceilingHeight: 8 })): Session {
  return reduceSession(createEmptySession(), {
    type: 'document.open',
    loaded: asLoadedDocument(document),
  });
}

function run(session: Session, ...actions: SessionAction[]): Session {
  return actions.reduce(reduceSession, session);
}

const dispatch = (command: EditorCommand): SessionAction => ({ type: 'command.dispatch', command });
const UNDO: SessionAction = { type: 'history.undo' };
const REDO: SessionAction = { type: 'history.redo' };

describe('reduceSession', () => {
  describe('command.dispatch', () => {
    it('applies the command and records one labeled entry', () => {
      const before = sessionWith();
      const after = reduceSession(before, dispatch(setCeiling(10)));

      expect(after.document.space.ceilingHeight).toBe(10);
      expect(after.history.past).toEqual([
        { document: before.document, label: 'Change ceiling height' },
      ]);
      expect(after.history.future).toEqual([]);
    });

    it('records one entry for a compound command', () => {
      const after = reduceSession(
        sessionWith(),
        dispatch({
          type: 'compound',
          label: 'Set up room',
          commands: [setCeiling(10), { type: 'room.close', walls: rectWalls(10, 10) }],
        })
      );

      expect(after.history.past).toHaveLength(1);
      expect(undoLabel(after.history)).toBe('Set up room');
    });

    it('returns the same session for a value-equal result, so no entry appears', () => {
      const before = reduceSession(sessionWith(), dispatch(setCeiling(10)));
      const after = reduceSession(before, dispatch(setCeiling(10)));

      // Reference equality is the contract: the store skips its write on it.
      expect(after).toBe(before);
      expect(after.history.past).toHaveLength(1);
    });

    it('clears the redo stack', () => {
      const session = run(sessionWith(), dispatch(setCeiling(10)), UNDO);
      expect(canRedo(session.history)).toBe(true);

      const after = reduceSession(session, dispatch(setCeiling(20)));
      expect(after.history.future).toEqual([]);
    });

    it('does not touch selection, carried state or diagnostics', () => {
      const before = sessionWith();
      const after = reduceSession(before, dispatch(setCeiling(10)));

      expect(after.selection).toBe(before.selection);
      expect(after.carried).toBe(before.carried);
      expect(after.diagnostics).toBe(before.diagnostics);
    });
  });

  describe('labels ride with the snapshots', () => {
    it('names the undo and redo edits at every step of a mixed sequence', () => {
      // A = "Change ceiling height", B = "Move wall"
      let session = sessionWith(squareRoom());
      expect(undoLabel(session.history)).toBeNull();
      expect(redoLabel(session.history)).toBeNull();

      session = reduceSession(session, dispatch(setCeiling(10))); // dispatch A
      expect(undoLabel(session.history)).toBe('Change ceiling height');
      expect(redoLabel(session.history)).toBeNull();

      session = reduceSession(session, dispatch(moveWall(-3))); // dispatch B
      expect(undoLabel(session.history)).toBe('Move wall');
      expect(redoLabel(session.history)).toBeNull();

      session = reduceSession(session, UNDO); // undo B
      expect(undoLabel(session.history)).toBe('Change ceiling height');
      expect(redoLabel(session.history)).toBe('Move wall');

      session = reduceSession(session, UNDO); // undo A
      expect(undoLabel(session.history)).toBeNull();
      expect(redoLabel(session.history)).toBe('Change ceiling height');

      session = reduceSession(session, REDO); // redo A
      expect(undoLabel(session.history)).toBe('Change ceiling height');
      expect(redoLabel(session.history)).toBe('Move wall');

      // ...and the document tracked the labels
      expect(session.document.space.ceilingHeight).toBe(10);
      expect(session.document.geometry.boundary.walls[0].start.y).toBe(0);
    });
  });

  describe('history limit', () => {
    it('evicts oldest-first from past, and undo moves rather than evicts', () => {
      let session = sessionWith();
      const documents = [session.document];

      for (let i = 1; i <= MAX_HISTORY + 1; i++) {
        session = reduceSession(session, dispatch(setCeiling(i)));
        documents.push(session.document);
      }

      expect(session.history.past).toHaveLength(MAX_HISTORY);
      // Entry 1 — the snapshot of the document before the first dispatch — was evicted.
      expect(session.history.past.map((e) => e.document)).not.toContain(documents[0]);
      expect(session.history.past[0].document).toBe(documents[1]);

      for (let i = 0; i < MAX_HISTORY; i++) {
        session = reduceSession(session, UNDO);
      }

      expect(session.history.past).toHaveLength(0);
      expect(session.history.future).toHaveLength(MAX_HISTORY);
      expect(session.history.past.length + session.history.future.length).toBe(MAX_HISTORY);
      // The oldest reachable document is the one after the evicted entry, not the original.
      expect(session.document).toBe(documents[1]);
    });
  });

  describe('history.undo / history.redo', () => {
    it('are no-ops on empty stacks, by reference', () => {
      const session = sessionWith();
      expect(reduceSession(session, UNDO)).toBe(session);
      expect(reduceSession(session, REDO)).toBe(session);
      expect(canUndo(session.history)).toBe(false);
      expect(canRedo(session.history)).toBe(false);
    });

    it('clears a pending interaction in the same value as the document swap', () => {
      const withHistory = run(sessionWith(squareRoom()), dispatch(setCeiling(10)), {
        type: 'interaction.set',
        interaction: { kind: 'commandPreview', command: moveWall(-3) },
      });
      expect(withHistory.interaction.kind).toBe('commandPreview');

      const undone = reduceSession(withHistory, UNDO);
      expect(undone.interaction).toEqual({ kind: 'idle' });
      expect(undone.document.space.ceilingHeight).toBe(8);

      const previewAgain = reduceSession(undone, {
        type: 'interaction.set',
        interaction: { kind: 'commandPreview', command: moveWall(-3) },
      });
      const redone = reduceSession(previewAgain, REDO);
      expect(redone.interaction).toEqual({ kind: 'idle' });
      expect(redone.document.space.ceilingHeight).toBe(10);
    });

    it('clears an interaction whose entity the restored snapshot no longer contains', () => {
      // Add a light, start dragging it, then undo the add. The candidate command names an id
      // that does not exist in the restored document; re-applying it would throw or silently
      // resolve against the wrong entity, so it must be dropped in the same emission.
      const added = reduceSession(
        sessionWith(squareRoom()),
        dispatch({ type: 'light.add', light: makeLight('light-1', { x: 5, y: 5 }) })
      );
      const dragging = reduceSession(added, {
        type: 'interaction.set',
        interaction: {
          kind: 'commandPreview',
          command: { type: 'light.move', lightId: 'light-1', position: { x: 7, y: 7 } },
        },
      });

      const undone = reduceSession(dragging, UNDO);

      expect(undone.interaction).toEqual({ kind: 'idle' });
      expect(undone.document.lights).toHaveLength(0);
    });
  });

  describe('interaction', () => {
    it('interaction.set writes no history and does not touch the document', () => {
      const before = sessionWith(squareRoom());
      const after = reduceSession(before, {
        type: 'interaction.set',
        interaction: { kind: 'commandPreview', command: moveWall(-3) },
      });

      expect(after.document).toBe(before.document);
      expect(after.history).toBe(before.history);
    });

    it('interaction.set is a no-op by reference when the value is unchanged', () => {
      const before = reduceSession(sessionWith(squareRoom()), {
        type: 'interaction.set',
        interaction: { kind: 'commandPreview', command: moveWall(-3) },
      });
      const after = reduceSession(before, {
        type: 'interaction.set',
        interaction: { kind: 'commandPreview', command: moveWall(-3) },
      });
      expect(after).toBe(before);
    });

    it('interaction.cancel discards the candidate command and commits nothing', () => {
      const before = sessionWith(squareRoom());
      const previewing = reduceSession(before, {
        type: 'interaction.set',
        interaction: { kind: 'commandPreview', command: moveWall(-3) },
      });
      const cancelled = reduceSession(previewing, { type: 'interaction.cancel' });

      expect(cancelled.interaction).toEqual({ kind: 'idle' });
      expect(cancelled.document).toBe(before.document);
      expect(cancelled.history.past).toHaveLength(0);
      // Cancelling when already idle is a no-op by reference.
      expect(reduceSession(cancelled, { type: 'interaction.cancel' })).toBe(cancelled);
    });

    it('interaction.commit dispatches the previewed command and idles in one value', () => {
      const previewing = reduceSession(sessionWith(squareRoom()), {
        type: 'interaction.set',
        interaction: { kind: 'commandPreview', command: moveWall(-3) },
      });

      const committed = reduceSession(previewing, { type: 'interaction.commit' });

      expect(committed.interaction).toEqual({ kind: 'idle' });
      expect(committed.document.geometry.boundary.walls[0].start.y).toBe(-3);
      expect(undoLabel(committed.history)).toBe('Move wall');
      expect(committed.history.past).toHaveLength(1);
    });

    it('interaction.commit of a value-equal command idles without a history entry', () => {
      const base = sessionWith(squareRoom());
      const previewing = reduceSession(base, {
        type: 'interaction.set',
        interaction: { kind: 'commandPreview', command: moveWall(0) },
      });

      const committed = reduceSession(previewing, { type: 'interaction.commit' });

      expect(committed.interaction).toEqual({ kind: 'idle' });
      expect(committed.document).toBe(base.document);
      expect(committed.history.past).toHaveLength(0);
    });

    it('interaction.commit with nothing pending is a no-op by reference', () => {
      const session = sessionWith();
      expect(reduceSession(session, { type: 'interaction.commit' })).toBe(session);
    });
  });

  describe('document.open', () => {
    it('pushes no undo entry and discards the history it replaces', () => {
      const session = run(sessionWith(), dispatch(setCeiling(10)), dispatch(setCeiling(12)), UNDO);
      expect(canUndo(session.history)).toBe(true);
      expect(canRedo(session.history)).toBe(true);

      const opened = reduceSession(session, {
        type: 'document.open',
        loaded: asLoadedDocument(squareRoom()),
      });

      expect(opened.history.past).toHaveLength(0);
      expect(opened.history.future).toHaveLength(0);
      expect(canUndo(opened.history)).toBe(false);
    });

    it('clears the interaction and the selection', () => {
      const busy = run(
        sessionWith(squareRoom()),
        { type: 'selection.set', selection: { kind: 'wall', id: 'wall-1' } },
        { type: 'interaction.set', interaction: { kind: 'commandPreview', command: moveWall(-3) } }
      );
      expect(busy.selection).toEqual({ kind: 'wall', id: 'wall-1' });
      expect(busy.interaction.kind).toBe('commandPreview');

      const opened = reduceSession(busy, {
        type: 'document.open',
        loaded: asLoadedDocument(makeDocument()),
      });

      expect(opened.selection).toEqual({ kind: 'none' });
      expect(opened.interaction).toEqual({ kind: 'idle' });
    });

    it('replaces carried state and diagnostics with the load result', () => {
      const loaded = asLoadedDocument(squareRoom());
      loaded.carried = { quarantined: {}, geometryFingerprint: 'abc' };
      loaded.diagnostics = {
        warnings: [{ message: 'saved by a newer version' }],
        runtimeStatus: {},
      };

      const opened = reduceSession(sessionWith(), { type: 'document.open', loaded });

      expect(opened.carried.geometryFingerprint).toBe('abc');
      expect(opened.diagnostics.warnings).toHaveLength(1);
      expect(opened.document).toBe(loaded.document);
    });
  });

  describe('selection.set', () => {
    it('replaces the whole value, so nothing has to be cross-cleared', () => {
      const wall = reduceSession(sessionWith(), {
        type: 'selection.set',
        selection: { kind: 'wall', id: 'wall-1' },
      });
      const door = reduceSession(wall, {
        type: 'selection.set',
        selection: { kind: 'door', id: 'door-1' },
      });

      expect(door.selection).toEqual({ kind: 'door', id: 'door-1' });
    });

    it('writes no history and is a no-op by reference when unchanged', () => {
      const before = reduceSession(sessionWith(), {
        type: 'selection.set',
        selection: { kind: 'vertex', indices: [1, 2] },
      });
      expect(before.history.past).toHaveLength(0);
      expect(
        reduceSession(before, {
          type: 'selection.set',
          selection: { kind: 'vertex', indices: [1, 2] },
        })
      ).toBe(before);
    });
  });

  describe('diagnostics.setRuntimeStatus', () => {
    it('records per-module status without touching the document or history', () => {
      const before = sessionWith();
      const after = reduceSession(before, {
        type: 'diagnostics.setRuntimeStatus',
        moduleId: 'lighting',
        status: { kind: 'failed', message: 'import failed' },
      });

      expect(after.diagnostics.runtimeStatus.lighting).toEqual({
        kind: 'failed',
        message: 'import failed',
      });
      expect(after.document).toBe(before.document);
      expect(after.history).toBe(before.history);
      expect(
        reduceSession(after, {
          type: 'diagnostics.setRuntimeStatus',
          moduleId: 'lighting',
          status: { kind: 'failed', message: 'import failed' },
        })
      ).toBe(after);
    });
  });

  describe('immutability', () => {
    it('freezes the documents it produces in dev, so a mutating handler cannot hide', () => {
      const session = reduceSession(sessionWith(), dispatch(setCeiling(10)));
      expect(Object.isFrozen(session.document)).toBe(true);
      expect(Object.isFrozen(session.document.geometry.boundary.walls)).toBe(true);
      expect(() => {
        (session.document.space as { ceilingHeight: number }).ceilingHeight = 99;
      }).toThrow();
    });
  });
});
