/**
 * Display preferences are document data. These assert there is exactly one source of truth:
 * opening a document is enough to update them (no `initSettingsFromRoom` step), and every
 * setter is an ordinary undoable command.
 *
 * Rafter, dead-zone and spacing settings moved into `modules.lighting` in phase 3b; they are
 * covered by `lightingStore.test.ts`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import {
  displayPreferences,
  toggleGridSnap,
  toggleUnitFormat,
  cycleLightRadiusVisibility,
} from '../../../src/stores/settingsStore';
import { sessionStore } from '../../../src/stores/sessionStore';
import { asLoadedDocument } from '../../../src/types/session';
import { DEFAULT_DISPLAY_PREFERENCES } from '../../../src/types';
import { squareRoom } from '../../helpers/documents';

describe('settings projections', () => {
  beforeEach(() => {
    sessionStore.open(asLoadedDocument(squareRoom()));
  });

  it('fall back to defaults for a document that carries none', () => {
    expect(get(displayPreferences)).toEqual(DEFAULT_DISPLAY_PREFERENCES);
  });

  it('follow the document without an explicit init step', () => {
    const doc = squareRoom();
    doc.displayPreferences = { ...DEFAULT_DISPLAY_PREFERENCES, unitFormat: 'inches' };

    sessionStore.open(asLoadedDocument(doc));

    expect(get(displayPreferences).unitFormat).toBe('inches');
  });

  it('migrate a legacy lightRadiusVisibility on read', () => {
    const doc = squareRoom();
    doc.displayPreferences = {
      ...DEFAULT_DISPLAY_PREFERENCES,
      lightRadiusVisibility: 'never' as never,
    };

    sessionStore.open(asLoadedDocument(doc));

    expect(get(displayPreferences).lightRadiusVisibility).toBe('selected');
  });

  it('write through the command layer, so they are undoable', () => {
    toggleGridSnap();
    expect(get(displayPreferences).gridSnapEnabled).toBe(
      !DEFAULT_DISPLAY_PREFERENCES.gridSnapEnabled
    );

    sessionStore.undo();
    expect(get(displayPreferences).gridSnapEnabled).toBe(
      DEFAULT_DISPLAY_PREFERENCES.gridSnapEnabled
    );
  });

  it('do not emit when an unrelated part of the document changes', () => {
    let emissions = -1;
    const stop = displayPreferences.subscribe(() => {
      emissions++;
    });
    sessionStore.dispatch({ type: 'space.setCeilingHeight', height: 11 });
    stop();

    expect(emissions).toBe(0);
  });

  it('each setter changes exactly its own field', () => {
    const beforeSnap = get(displayPreferences).gridSnapEnabled;
    toggleGridSnap();
    expect(get(displayPreferences).gridSnapEnabled).toBe(!beforeSnap);

    toggleUnitFormat();
    expect(get(displayPreferences).unitFormat).not.toBe(DEFAULT_DISPLAY_PREFERENCES.unitFormat);

    cycleLightRadiusVisibility();
    expect(get(displayPreferences).lightRadiusVisibility).toBe('always');
    cycleLightRadiusVisibility();
    expect(get(displayPreferences).lightRadiusVisibility).toBe('selected');
  });
});
