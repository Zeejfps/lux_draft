/**
 * Rafter and display preferences are document data. These assert there is exactly one source
 * of truth: opening a document is enough to update them (no `initSettingsFromRoom` step), and
 * every setter is an ordinary undoable command.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import {
  rafterConfig,
  displayPreferences,
  toggleRafters,
  setRafterSpacing,
  toggleGridSnap,
  toggleUnitFormat,
  cycleLightRadiusVisibility,
} from '../../../src/stores/settingsStore';
import { sessionStore, committedDocument } from '../../../src/stores/sessionStore';
import { asLoadedDocument } from '../../../src/types/session';
import { DEFAULT_RAFTER_CONFIG, DEFAULT_DISPLAY_PREFERENCES } from '../../../src/types';
import { squareRoom } from '../../helpers/documents';

describe('settings projections', () => {
  beforeEach(() => {
    sessionStore.open(asLoadedDocument(squareRoom()));
  });

  it('fall back to defaults for a document that carries none', () => {
    expect(get(rafterConfig)).toEqual(DEFAULT_RAFTER_CONFIG);
    expect(get(displayPreferences)).toEqual(DEFAULT_DISPLAY_PREFERENCES);
  });

  it('follow the document without an explicit init step', () => {
    const doc = squareRoom();
    doc.rafterConfig = { ...DEFAULT_RAFTER_CONFIG, visible: true, spacing: 2 };
    doc.displayPreferences = { ...DEFAULT_DISPLAY_PREFERENCES, unitFormat: 'inches' };

    sessionStore.open(asLoadedDocument(doc));

    expect(get(rafterConfig).spacing).toBe(2);
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
    toggleRafters();
    expect(get(rafterConfig).visible).toBe(!DEFAULT_RAFTER_CONFIG.visible);
    expect(get(committedDocument).rafterConfig?.visible).toBe(!DEFAULT_RAFTER_CONFIG.visible);

    sessionStore.undo();
    expect(get(rafterConfig).visible).toBe(DEFAULT_RAFTER_CONFIG.visible);
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
    setRafterSpacing(3);
    expect(get(rafterConfig).spacing).toBe(3);
    expect(get(rafterConfig).orientation).toBe(DEFAULT_RAFTER_CONFIG.orientation);

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
