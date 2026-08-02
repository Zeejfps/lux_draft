import { writable, get } from 'svelte/store';
import type { EditorDocument } from '../types/document';
import { committedRoom, interaction } from './roomStore';
import { IDLE_INTERACTION } from '../types/interaction';

interface HistoryState {
  past: EditorDocument[];
  future: EditorDocument[];
}

const MAX_HISTORY = 50;

/**
 * Check if two documents are equivalent (for avoiding duplicate history entries).
 *
 * Phase 1a still *infers* history by diffing the committed document: one dispatch is one
 * update, so one entry. Phase 1b deletes this and moves history into `reduceSession` with a
 * label per entry. The no-op guarantee does not depend on this diff — `dispatch` already
 * returns the same reference for a value-equal result.
 */
function statesAreEqual(a: EditorDocument | null, b: EditorDocument): boolean {
  if (!a) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function createHistoryStore() {
  const { subscribe, set, update } = writable<HistoryState>({
    past: [],
    future: [],
  });

  let isPerformingHistoryOperation = false;
  let lastSavedState: EditorDocument | null = null;

  /**
   * Push a state onto the history stack, respecting max history limit.
   */
  function pushToHistory(stateToPush: EditorDocument): void {
    update((history) => {
      const newPast = [...history.past, stateToPush];
      // Limit history size
      if (newPast.length > MAX_HISTORY) {
        newPast.shift();
      }
      return {
        past: newPast,
        future: [], // Clear future on new action
      };
    });
  }

  // Subscribe to the *committed* document — a preview must never make history
  committedRoom.subscribe((state) => {
    if (isPerformingHistoryOperation) return;

    // Don't record if state hasn't meaningfully changed
    if (statesAreEqual(lastSavedState, state)) {
      return;
    }

    if (lastSavedState !== null) {
      pushToHistory(lastSavedState);
    }

    lastSavedState = structuredClone(state);
  });

  return {
    subscribe,

    undo: () => {
      const history = get({ subscribe });
      if (history.past.length === 0) return false;

      isPerformingHistoryOperation = true;

      const currentState = get(committedRoom);
      const previousState = history.past[history.past.length - 1];

      update((h) => ({
        past: h.past.slice(0, -1),
        future: [currentState, ...h.future],
      }));

      // Undo and redo clear the interaction: a surviving candidate command would be
      // re-applied to the restored document using ids resolved against the pre-undo one.
      interaction.set(IDLE_INTERACTION);
      committedRoom.set(previousState);
      lastSavedState = structuredClone(previousState);

      isPerformingHistoryOperation = false;
      return true;
    },

    redo: () => {
      const history = get({ subscribe });
      if (history.future.length === 0) return false;

      isPerformingHistoryOperation = true;

      const currentState = get(committedRoom);
      const nextState = history.future[0];

      update((h) => ({
        past: [...h.past, currentState],
        future: h.future.slice(1),
      }));

      interaction.set(IDLE_INTERACTION);
      committedRoom.set(nextState);
      lastSavedState = structuredClone(nextState);

      isPerformingHistoryOperation = false;
      return true;
    },

    clear: () => {
      set({ past: [], future: [] });
      lastSavedState = structuredClone(get(committedRoom));
    },

    canUndo: () => {
      const history = get({ subscribe });
      return history.past.length > 0;
    },

    canRedo: () => {
      const history = get({ subscribe });
      return history.future.length > 0;
    },
  };
}

export const historyStore = createHistoryStore();

// Derived stores for UI bindings
export const canUndo = writable(false);
export const canRedo = writable(false);

// Update derived stores when history changes
historyStore.subscribe((history) => {
  canUndo.set(history.past.length > 0);
  canRedo.set(history.future.length > 0);
});
