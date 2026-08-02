import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import {
  roomStore,
  committedDocument,
  dispatch,
  openDocument,
} from '../../../src/stores/roomStore';
import { addLight } from '../../../src/stores/lightingStore';
import { moveFixture } from '../../../src/modules/lighting/commands';
import { sessionStore, history } from '../../../src/stores/sessionStore';
import {
  canUndo as historyCanUndo,
  canRedo as historyCanRedo,
  undoLabel,
  redoLabel,
} from '../../../src/types/session';
import { lightsOf, makeDocument, makeLight, rectWalls } from '../../helpers/documents';

/** History is a slice of the session now; these read it exactly as the toolbar does. */
function canUndo(): boolean {
  return historyCanUndo(get(history));
}

function canRedo(): boolean {
  return historyCanRedo(get(history));
}

function setCeiling(height: number): void {
  dispatch({ type: 'space.setCeilingHeight', height });
}

function ceiling(): number {
  return get(roomStore).space.ceilingHeight;
}

function walls() {
  return get(roomStore).geometry.boundary.walls;
}

describe('session history', () => {
  beforeEach(() => {
    // `open` replaces the document *and* clears history in one action — a load is not an edit.
    openDocument(makeDocument({ ceilingHeight: 8 }));
  });

  describe('basic functionality', () => {
    it('starts with empty history', () => {
      expect(canUndo()).toBe(false);
      expect(canRedo()).toBe(false);
    });

    it('records state changes', () => {
      setCeiling(10);

      expect(canUndo()).toBe(true);
      expect(canRedo()).toBe(false);
    });

    it('can undo a state change', () => {
      const initialHeight = ceiling();

      setCeiling(12);
      expect(ceiling()).toBe(12);

      const result = sessionStore.undo();
      expect(result).toBe(true);
      expect(ceiling()).toBe(initialHeight);
    });

    it('can redo after undo', () => {
      setCeiling(15);

      sessionStore.undo();
      expect(canRedo()).toBe(true);

      const result = sessionStore.redo();
      expect(result).toBe(true);
      expect(ceiling()).toBe(15);
    });

    it('clears redo history on new action after undo', () => {
      setCeiling(10);
      setCeiling(12);

      sessionStore.undo();
      expect(canRedo()).toBe(true);

      setCeiling(20);

      expect(canRedo()).toBe(false);
    });

    it('returns false when trying to undo with no history', () => {
      const result = sessionStore.undo();
      expect(result).toBe(false);
    });

    it('returns false when trying to redo with no future', () => {
      const result = sessionStore.redo();
      expect(result).toBe(false);
    });

    it('opening a document clears history and pushes no entry of its own', () => {
      setCeiling(10);
      setCeiling(12);

      expect(canUndo()).toBe(true);

      openDocument(makeDocument({ ceilingHeight: 12 }));

      expect(canUndo()).toBe(false);
      expect(canRedo()).toBe(false);
    });
  });

  describe('multiple operations', () => {
    it('handles multiple undos', () => {
      const initialHeight = ceiling();

      setCeiling(10);
      setCeiling(12);
      setCeiling(14);

      sessionStore.undo();
      expect(ceiling()).toBe(12);

      sessionStore.undo();
      expect(ceiling()).toBe(10);

      sessionStore.undo();
      expect(ceiling()).toBe(initialHeight);

      expect(canUndo()).toBe(false);
    });

    it('handles multiple redos', () => {
      setCeiling(10);
      setCeiling(12);
      setCeiling(14);

      // Undo all
      sessionStore.undo();
      sessionStore.undo();
      sessionStore.undo();

      // Redo all
      sessionStore.redo();
      expect(ceiling()).toBe(10);

      sessionStore.redo();
      expect(ceiling()).toBe(12);

      sessionStore.redo();
      expect(ceiling()).toBe(14);

      expect(canRedo()).toBe(false);
    });

    it('handles alternating undo/redo', () => {
      setCeiling(10);
      setCeiling(12);

      sessionStore.undo();
      expect(ceiling()).toBe(10);

      sessionStore.redo();
      expect(ceiling()).toBe(12);

      sessionStore.undo();
      expect(ceiling()).toBe(10);

      sessionStore.redo();
      expect(ceiling()).toBe(12);
    });
  });

  describe('complex state changes', () => {
    it('handles undo/redo of wall changes', () => {
      dispatch({ type: 'room.close', walls: rectWalls(10, 10) });
      expect(walls().length).toBe(4);

      sessionStore.undo();
      expect(walls().length).toBe(0);

      sessionStore.redo();
      expect(walls().length).toBe(4);
    });

    it('handles undo/redo of light changes', () => {
      addLight(makeLight('light-1', { x: 5, y: 5 }));
      expect(lightsOf(get(roomStore)).length).toBe(1);

      sessionStore.undo();
      expect(lightsOf(get(roomStore)).length).toBe(0);

      sessionStore.redo();
      expect(lightsOf(get(roomStore)).length).toBe(1);
    });

    it('records one entry for a compound command', () => {
      dispatch({
        type: 'compound',
        label: 'Set up room',
        commands: [
          { type: 'space.setCeilingHeight', height: 10 },
          { type: 'room.close', walls: rectWalls(10, 10) },
        ],
      });

      expect(ceiling()).toBe(10);
      expect(get(roomStore).geometry.boundary.isClosed).toBe(true);

      sessionStore.undo();

      expect(ceiling()).toBe(8);
      expect(get(roomStore).geometry.boundary.isClosed).toBe(false);
      expect(canUndo()).toBe(false);
    });
  });

  describe('duplicate state detection', () => {
    it('does not record duplicate states', () => {
      setCeiling(10);
      expect(canUndo()).toBe(true);

      // Dispatch the same absolute value - no emission, so no new history entry
      setCeiling(10);

      // Should still only need one undo
      sessionStore.undo();
      expect(ceiling()).toBe(8);
      expect(canUndo()).toBe(false);
    });

    it('a value-equal result keeps the same document reference', () => {
      const light = makeLight('light-1', { x: 5, y: 5 });
      addLight(light);

      const before = get(committedDocument);
      dispatch(moveFixture.make({ fixtureId: 'light-1', position: { x: 5, y: 5 } }));

      expect(get(committedDocument)).toBe(before);

      sessionStore.undo();
      expect(lightsOf(get(roomStore)).length).toBe(0);
      expect(canUndo()).toBe(false);
    });
  });

  describe('history limit', () => {
    it('limits history to MAX_HISTORY entries', () => {
      // Make 60 changes (more than MAX_HISTORY of 50)
      for (let i = 1; i <= 60; i++) {
        setCeiling(i);
      }

      // Count how many undos we can do
      let undoCount = 0;
      while (sessionStore.undo()) {
        undoCount++;
      }

      // Should be limited to 50
      expect(undoCount).toBe(50);
    });

    it('preserves most recent states when limit exceeded', () => {
      // Make 55 changes
      for (let i = 1; i <= 55; i++) {
        setCeiling(i);
      }

      // Current state should be 55
      expect(ceiling()).toBe(55);

      // Undo 50 times
      for (let i = 0; i < 50; i++) {
        sessionStore.undo();
      }

      // Initial + 55 changes, keep last 50, so after 50 undos we are at 5
      expect(ceiling()).toBe(5);
    });
  });

  describe('canUndo and canRedo functions', () => {
    it('canUndo() returns correct value', () => {
      expect(canUndo()).toBe(false);

      setCeiling(10);
      expect(canUndo()).toBe(true);

      sessionStore.undo();
      expect(canUndo()).toBe(false);
    });

    it('canRedo() returns correct value', () => {
      expect(canRedo()).toBe(false);

      setCeiling(10);
      expect(canRedo()).toBe(false);

      sessionStore.undo();
      expect(canRedo()).toBe(true);

      sessionStore.redo();
      expect(canRedo()).toBe(false);
    });

    it('the history slice carries the labels through the store', () => {
      setCeiling(10);
      expect(undoLabel(get(history))).toBe('Change ceiling height');
      expect(redoLabel(get(history))).toBeNull();

      sessionStore.undo();
      expect(undoLabel(get(history))).toBeNull();
      expect(redoLabel(get(history))).toBe('Change ceiling height');
    });
  });

  describe('edge cases', () => {
    it('handles undo immediately after opening a document', () => {
      setCeiling(10);
      openDocument(makeDocument({ ceilingHeight: 10 }));

      const result = sessionStore.undo();
      expect(result).toBe(false);
    });

    it('handles rapid state changes', () => {
      // Simulate rapid changes like during typing
      for (let i = 1; i <= 10; i++) {
        setCeiling(8 + i * 0.1);
      }

      expect(canUndo()).toBe(true);

      // Should be able to undo each change
      let count = 0;
      while (sessionStore.undo()) {
        count++;
      }
      expect(count).toBe(10);
    });

    it('maintains state integrity after undo/redo cycle', () => {
      const originalState = get(roomStore);

      setCeiling(10);
      setCeiling(12);

      sessionStore.undo();
      sessionStore.undo();
      sessionStore.redo();
      sessionStore.redo();
      sessionStore.undo();
      sessionStore.undo();

      expect(get(roomStore)).toEqual(originalState);
    });

    it('handles nested object changes', () => {
      addLight(makeLight('light-1', { x: 5, y: 5 }));

      dispatch(moveFixture.make({ fixtureId: 'light-1', position: { x: 10, y: 5 } }));
      expect(lightsOf(get(roomStore))[0].position.x).toBe(10);

      sessionStore.undo();
      expect(lightsOf(get(roomStore))[0].position.x).toBe(5);

      sessionStore.undo();
      expect(lightsOf(get(roomStore)).length).toBe(0);
    });
  });

  describe('integration scenarios', () => {
    it('simulates drawing walls with undo', () => {
      const w = rectWalls(10, 10);

      dispatch({ type: 'room.close', walls: [w[0]] });
      dispatch({ type: 'room.close', walls: [w[0], w[1]] });
      dispatch({ type: 'room.close', walls: [w[0], w[1], w[2]] });

      expect(walls().length).toBe(3);

      sessionStore.undo();
      expect(walls().length).toBe(2);

      sessionStore.redo();
      expect(walls().length).toBe(3);

      sessionStore.undo();
      sessionStore.undo();
      expect(walls().length).toBe(1);
    });

    it('handles a document open followed by new changes', () => {
      setCeiling(10);
      setCeiling(12);

      openDocument(makeDocument({ ceilingHeight: 12 }));

      setCeiling(14);
      setCeiling(16);

      sessionStore.undo();
      expect(ceiling()).toBe(14);

      sessionStore.undo();
      expect(ceiling()).toBe(12);

      expect(canUndo()).toBe(false);
    });
  });
});
