import type { Readable } from 'svelte/store';
import type { LoadedDocument, SaveInput } from '../types/session';
import { decodeDocument, encodeDocument } from './documentCodec';

/**
 * Local storage goes through the one document codec like every other entry point
 * (invariant 9). It used to be the weakest of the three — `JSON.parse(data) as RoomState`
 * with ad-hoc shape sniffing and no validation — and it is the most common source of
 * pre-migration documents, which is why the envelope's unversioned reader is permanent.
 */

const STORAGE_KEY = 'lumen2d_project';
const AUTOSAVE_INTERVAL = 30000;

export function saveToLocalStorage({ document, carried }: SaveInput): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(encodeDocument(document, carried, { kind: 'local' }))
    );
  } catch (e) {
    console.error('Failed to save to localStorage:', e);
  }
}

/**
 * The stored project, or null when there is none or it could not be read at all.
 *
 * Only geometry failure is fatal; an undecodable module slice quarantines and still returns a
 * document (invariant 8), so a broken lighting blob no longer costs the user their room.
 */
export function loadFromLocalStorage(): LoadedDocument | null {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) return null;
    return decodeDocument(JSON.parse(data));
  } catch (e) {
    console.error('Failed to load from localStorage:', e);
    return null;
  }
}

export function clearLocalStorage(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/** Autosave reads the committed document — never the live preview. */
export function setupAutoSave(store: Readable<SaveInput>): () => void {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let last: SaveInput | null = null;

  const unsubscribe = store.subscribe((input) => {
    if (last && JSON.stringify(input.document) === JSON.stringify(last.document)) {
      return;
    }

    last = input;

    if (timeout) {
      clearTimeout(timeout);
    }

    timeout = setTimeout(() => {
      saveToLocalStorage(input);
    }, AUTOSAVE_INTERVAL);
  });

  return () => {
    unsubscribe();
    if (timeout) {
      clearTimeout(timeout);
    }
  };
}

export function saveNow(input: SaveInput): void {
  saveToLocalStorage(input);
}
