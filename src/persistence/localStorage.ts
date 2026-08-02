import type { Readable } from 'svelte/store';
import type { RoomState } from '../types';
import type { EditorDocument } from '../types/document';
import { fromLegacyRoomState, toLegacyRoomState } from './legacyDocumentAdapter';

const STORAGE_KEY = 'lumen2d_project';
const AUTOSAVE_INTERVAL = 30000;

export function saveToLocalStorage(doc: EditorDocument): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toLegacyRoomState(doc)));
  } catch (e) {
    console.error('Failed to save to localStorage:', e);
  }
}

export function loadFromLocalStorage(): EditorDocument | null {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) return null;
    const state = JSON.parse(data) as RoomState;
    // Migration: add doors array if missing (for backwards compatibility)
    if (!state.doors) {
      state.doors = [];
    }
    // Migration: add swingSide to doors if missing
    for (const door of state.doors) {
      if (!door.swingSide) {
        door.swingSide = 'inside';
      }
    }
    // Migration: add obstacles array if missing
    if (!state.obstacles) {
      state.obstacles = [];
    }
    return fromLegacyRoomState(state);
  } catch (e) {
    console.error('Failed to load from localStorage:', e);
    return null;
  }
}

export function clearLocalStorage(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/** Autosave reads the committed document — never the live preview. */
export function setupAutoSave(store: Readable<EditorDocument>): () => void {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let lastDoc: EditorDocument | null = null;

  const unsubscribe = store.subscribe((doc) => {
    if (lastDoc && JSON.stringify(doc) === JSON.stringify(lastDoc)) {
      return;
    }

    lastDoc = doc;

    if (timeout) {
      clearTimeout(timeout);
    }

    timeout = setTimeout(() => {
      saveToLocalStorage(doc);
    }, AUTOSAVE_INTERVAL);
  });

  return () => {
    unsubscribe();
    if (timeout) {
      clearTimeout(timeout);
    }
  };
}

export function saveNow(doc: EditorDocument): void {
  saveToLocalStorage(doc);
}
