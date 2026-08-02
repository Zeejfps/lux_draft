import type { Readable } from 'svelte/store';
import type { DisplayPreferences, LightRadiusVisibility } from '../types';
import type { EditorDocument } from '../types/document';
import { DEFAULT_DISPLAY_PREFERENCES, migrateLightRadiusVisibility } from '../types';
import { valueEqual } from '../commands';
import { sessionStore, committedDocument } from './sessionStore';
import { documentSlice } from './documentSlice';

/**
 * Rafter and display preferences are **document data**, not store data.
 *
 * Until phase 1b these were two writables that mirrored themselves into the document by
 * dispatching on subscribe, with a re-entrancy flag to break the loop on load — a second
 * source of truth, and the flag was the tell. They are now read-only projections of the
 * committed document, and every setter is one command like any other edit.
 *
 * Phase 3b moved `rafterConfig` out of here and into `modules.lighting`; it lives in
 * `lightingStore.ts` with the rest of the lighting module's settings. What is left is
 * genuinely core: display preferences are a document field no module owns.
 */

/** Merged with defaults on read, so a document written by an older build is not a special case. */
function readDisplayPreferences(doc: EditorDocument): DisplayPreferences {
  const merged = { ...DEFAULT_DISPLAY_PREFERENCES, ...doc.displayPreferences };
  merged.lightRadiusVisibility = migrateLightRadiusVisibility(merged.lightRadiusVisibility);
  return merged;
}

// Defaults are merged on read, so the selector allocates; `valueEqual` rather than reference
// equality is what keeps a geometry edit from looking like a settings change to every panel.
export const displayPreferences: Readable<DisplayPreferences> = documentSlice(
  committedDocument,
  readDisplayPreferences,
  valueEqual
);

// ============================================
// Setters — one command each
// ============================================

export function updateDisplayPreferences(changes: Partial<DisplayPreferences>): void {
  const preferences = { ...readDisplayPreferences(sessionStore.current().document), ...changes };
  sessionStore.dispatch({ type: 'document.setDisplayPreferences', preferences });
}

export function toggleUnitFormat(): void {
  const current = readDisplayPreferences(sessionStore.current().document).unitFormat;
  updateDisplayPreferences({ unitFormat: current === 'feet-inches' ? 'inches' : 'feet-inches' });
}

export function toggleGridSnap(): void {
  const current = readDisplayPreferences(sessionStore.current().document).gridSnapEnabled;
  updateDisplayPreferences({ gridSnapEnabled: !current });
}

export function cycleLightRadiusVisibility(): void {
  const current = readDisplayPreferences(sessionStore.current().document).lightRadiusVisibility;
  const next: LightRadiusVisibility = current === 'selected' ? 'always' : 'selected';
  updateDisplayPreferences({ lightRadiusVisibility: next });
}
