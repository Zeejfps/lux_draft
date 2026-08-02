import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { historyStore, canUndo, canRedo } from '../../../src/stores/historyStore';
import {
  roomStore,
  committedRoom,
  dispatch,
  openDocument,
  addLight,
} from '../../../src/stores/roomStore';
import { makeDocument, makeLight, rectWalls } from '../../helpers/documents';

function setCeiling(height: number): void {
  dispatch({ type: 'space.setCeilingHeight', height });
}

function ceiling(): number {
  return get(roomStore).space.ceilingHeight;
}

function walls() {
  return get(roomStore).geometry.boundary.walls;
}

describe('historyStore', () => {
  beforeEach(() => {
    // Reset to initial state - open a document first, then clear history
    openDocument(makeDocument({ ceilingHeight: 8 }));
    historyStore.clear();
  });

  describe('basic functionality', () => {
    it('starts with empty history', () => {
      expect(get(canUndo)).toBe(false);
      expect(get(canRedo)).toBe(false);
    });

    it('records state changes', () => {
      setCeiling(10);

      expect(get(canUndo)).toBe(true);
      expect(get(canRedo)).toBe(false);
    });

    it('can undo a state change', () => {
      const initialHeight = ceiling();

      setCeiling(12);
      expect(ceiling()).toBe(12);

      const result = historyStore.undo();
      expect(result).toBe(true);
      expect(ceiling()).toBe(initialHeight);
    });

    it('can redo after undo', () => {
      setCeiling(15);

      historyStore.undo();
      expect(get(canRedo)).toBe(true);

      const result = historyStore.redo();
      expect(result).toBe(true);
      expect(ceiling()).toBe(15);
    });

    it('clears redo history on new action after undo', () => {
      setCeiling(10);
      setCeiling(12);

      historyStore.undo();
      expect(get(canRedo)).toBe(true);

      setCeiling(20);

      expect(get(canRedo)).toBe(false);
    });

    it('returns false when trying to undo with no history', () => {
      const result = historyStore.undo();
      expect(result).toBe(false);
    });

    it('returns false when trying to redo with no future', () => {
      const result = historyStore.redo();
      expect(result).toBe(false);
    });

    it('can clear history', () => {
      setCeiling(10);
      setCeiling(12);

      expect(get(canUndo)).toBe(true);

      historyStore.clear();

      expect(get(canUndo)).toBe(false);
      expect(get(canRedo)).toBe(false);
    });
  });

  describe('multiple operations', () => {
    it('handles multiple undos', () => {
      const initialHeight = ceiling();

      setCeiling(10);
      setCeiling(12);
      setCeiling(14);

      historyStore.undo();
      expect(ceiling()).toBe(12);

      historyStore.undo();
      expect(ceiling()).toBe(10);

      historyStore.undo();
      expect(ceiling()).toBe(initialHeight);

      expect(get(canUndo)).toBe(false);
    });

    it('handles multiple redos', () => {
      setCeiling(10);
      setCeiling(12);
      setCeiling(14);

      // Undo all
      historyStore.undo();
      historyStore.undo();
      historyStore.undo();

      // Redo all
      historyStore.redo();
      expect(ceiling()).toBe(10);

      historyStore.redo();
      expect(ceiling()).toBe(12);

      historyStore.redo();
      expect(ceiling()).toBe(14);

      expect(get(canRedo)).toBe(false);
    });

    it('handles alternating undo/redo', () => {
      setCeiling(10);
      setCeiling(12);

      historyStore.undo();
      expect(ceiling()).toBe(10);

      historyStore.redo();
      expect(ceiling()).toBe(12);

      historyStore.undo();
      expect(ceiling()).toBe(10);

      historyStore.redo();
      expect(ceiling()).toBe(12);
    });
  });

  describe('complex state changes', () => {
    it('handles undo/redo of wall changes', () => {
      dispatch({ type: 'room.close', walls: rectWalls(10, 10) });
      expect(walls().length).toBe(4);

      historyStore.undo();
      expect(walls().length).toBe(0);

      historyStore.redo();
      expect(walls().length).toBe(4);
    });

    it('handles undo/redo of light changes', () => {
      addLight(makeLight('light-1', { x: 5, y: 5 }));
      expect(get(roomStore).lights.length).toBe(1);

      historyStore.undo();
      expect(get(roomStore).lights.length).toBe(0);

      historyStore.redo();
      expect(get(roomStore).lights.length).toBe(1);
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

      historyStore.undo();

      expect(ceiling()).toBe(8);
      expect(get(roomStore).geometry.boundary.isClosed).toBe(false);
      expect(get(canUndo)).toBe(false);
    });
  });

  describe('duplicate state detection', () => {
    it('does not record duplicate states', () => {
      setCeiling(10);
      expect(get(canUndo)).toBe(true);

      // Dispatch the same absolute value - no emission, so no new history entry
      setCeiling(10);

      // Should still only need one undo
      historyStore.undo();
      expect(ceiling()).toBe(8);
      expect(get(canUndo)).toBe(false);
    });

    it('a value-equal result keeps the same document reference', () => {
      const light = makeLight('light-1', { x: 5, y: 5 });
      addLight(light);

      const before = get(committedRoom);
      dispatch({ type: 'light.move', lightId: 'light-1', position: { x: 5, y: 5 } });

      expect(get(committedRoom)).toBe(before);

      historyStore.undo();
      expect(get(roomStore).lights.length).toBe(0);
      expect(get(canUndo)).toBe(false);
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
      while (historyStore.undo()) {
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
        historyStore.undo();
      }

      // Initial + 55 changes, keep last 50, so after 50 undos we are at 5
      expect(ceiling()).toBe(5);
    });
  });

  describe('canUndo and canRedo functions', () => {
    it('canUndo() returns correct value', () => {
      expect(historyStore.canUndo()).toBe(false);

      setCeiling(10);
      expect(historyStore.canUndo()).toBe(true);

      historyStore.undo();
      expect(historyStore.canUndo()).toBe(false);
    });

    it('canRedo() returns correct value', () => {
      expect(historyStore.canRedo()).toBe(false);

      setCeiling(10);
      expect(historyStore.canRedo()).toBe(false);

      historyStore.undo();
      expect(historyStore.canRedo()).toBe(true);

      historyStore.redo();
      expect(historyStore.canRedo()).toBe(false);
    });

    it('derived stores stay in sync with functions', () => {
      setCeiling(10);

      expect(get(canUndo)).toBe(historyStore.canUndo());
      expect(get(canRedo)).toBe(historyStore.canRedo());

      historyStore.undo();

      expect(get(canUndo)).toBe(historyStore.canUndo());
      expect(get(canRedo)).toBe(historyStore.canRedo());
    });
  });

  describe('edge cases', () => {
    it('handles undo immediately after clear', () => {
      setCeiling(10);
      historyStore.clear();

      const result = historyStore.undo();
      expect(result).toBe(false);
    });

    it('handles rapid state changes', () => {
      // Simulate rapid changes like during typing
      for (let i = 1; i <= 10; i++) {
        setCeiling(8 + i * 0.1);
      }

      expect(get(canUndo)).toBe(true);

      // Should be able to undo each change
      let count = 0;
      while (historyStore.undo()) {
        count++;
      }
      expect(count).toBe(10);
    });

    it('maintains state integrity after undo/redo cycle', () => {
      const originalState = get(roomStore);

      setCeiling(10);
      setCeiling(12);

      historyStore.undo();
      historyStore.undo();
      historyStore.redo();
      historyStore.redo();
      historyStore.undo();
      historyStore.undo();

      expect(get(roomStore)).toEqual(originalState);
    });

    it('handles nested object changes', () => {
      addLight(makeLight('light-1', { x: 5, y: 5 }));

      dispatch({ type: 'light.move', lightId: 'light-1', position: { x: 10, y: 5 } });
      expect(get(roomStore).lights[0].position.x).toBe(10);

      historyStore.undo();
      expect(get(roomStore).lights[0].position.x).toBe(5);

      historyStore.undo();
      expect(get(roomStore).lights.length).toBe(0);
    });
  });

  describe('integration scenarios', () => {
    it('simulates drawing walls with undo', () => {
      const w = rectWalls(10, 10);

      dispatch({ type: 'room.close', walls: [w[0]] });
      dispatch({ type: 'room.close', walls: [w[0], w[1]] });
      dispatch({ type: 'room.close', walls: [w[0], w[1], w[2]] });

      expect(walls().length).toBe(3);

      historyStore.undo();
      expect(walls().length).toBe(2);

      historyStore.redo();
      expect(walls().length).toBe(3);

      historyStore.undo();
      historyStore.undo();
      expect(walls().length).toBe(1);
    });

    it('handles clear followed by new changes', () => {
      setCeiling(10);
      setCeiling(12);

      historyStore.clear();

      setCeiling(14);
      setCeiling(16);

      historyStore.undo();
      expect(ceiling()).toBe(14);

      historyStore.undo();
      expect(ceiling()).toBe(12);

      expect(get(canUndo)).toBe(false);
    });
  });
});
