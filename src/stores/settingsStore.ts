import type { Readable } from 'svelte/store';
import type { RafterConfig, DisplayPreferences, LightRadiusVisibility } from '../types';
import type { EditorDocument } from '../types/document';
import {
  DEFAULT_RAFTER_CONFIG,
  DEFAULT_DISPLAY_PREFERENCES,
  migrateLightRadiusVisibility,
} from '../types';
import { valueEqual } from '../commands';
import { sessionStore, committedDocument } from './sessionStore';

/**
 * Rafter and display preferences are **document data**, not store data.
 *
 * Until phase 1b these were two writables that mirrored themselves into the document by
 * dispatching on subscribe, with a re-entrancy flag to break the loop on load — a second
 * source of truth, and the flag was the tell. They are now read-only projections of the
 * committed document, and every setter is one command like any other edit.
 *
 * (Phase 3b moves `rafterConfig` into `modules.lighting`; only the selectors below and the
 * `lighting.setRafterConfig` handler have to follow it.)
 */
function projection<T>(select: (doc: EditorDocument) => T): Readable<T> {
  return {
    subscribe(run, invalidate) {
      let last: T;
      let started = false;
      return committedDocument.subscribe((doc) => {
        const next = select(doc);
        // Defaults are merged on read, so the selector allocates; without this guard every
        // geometry edit would look like a settings change to every panel and renderer.
        if (started && valueEqual(next, last)) return;
        started = true;
        last = next;
        run(next);
      }, invalidate);
    },
  };
}

/** Merged with defaults on read, so a document written by an older build is not a special case. */
function readRafterConfig(doc: EditorDocument): RafterConfig {
  return { ...DEFAULT_RAFTER_CONFIG, ...doc.rafterConfig };
}

function readDisplayPreferences(doc: EditorDocument): DisplayPreferences {
  const merged = { ...DEFAULT_DISPLAY_PREFERENCES, ...doc.displayPreferences };
  merged.lightRadiusVisibility = migrateLightRadiusVisibility(merged.lightRadiusVisibility);
  return merged;
}

export const rafterConfig: Readable<RafterConfig> = projection(readRafterConfig);

export const displayPreferences: Readable<DisplayPreferences> = projection(readDisplayPreferences);

// ============================================
// Setters — one command each
// ============================================

export function updateRafterConfig(changes: Partial<RafterConfig>): void {
  const config = { ...readRafterConfig(sessionStore.current().document), ...changes };
  sessionStore.dispatch({ type: 'lighting.setRafterConfig', config });
}

export function updateDisplayPreferences(changes: Partial<DisplayPreferences>): void {
  const preferences = { ...readDisplayPreferences(sessionStore.current().document), ...changes };
  sessionStore.dispatch({ type: 'document.setDisplayPreferences', preferences });
}

export function toggleRafters(): void {
  updateRafterConfig({ visible: !readRafterConfig(sessionStore.current().document).visible });
}

export function setRafterOrientation(orientation: 'horizontal' | 'vertical'): void {
  updateRafterConfig({ orientation });
}

export function setRafterSpacing(spacing: number): void {
  updateRafterConfig({ spacing });
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
