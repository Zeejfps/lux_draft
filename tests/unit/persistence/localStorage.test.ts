import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  saveToLocalStorage,
  loadFromLocalStorage,
  clearLocalStorage,
} from '../../../src/floorplan/persistence/localStorage';
import { createEmptyCarriedState } from '../../../src/floorplan/types/session';
import { geometryFingerprint } from '../../../src/floorplan/persistence/documentCodec';
import { lightsOf, makeDocument, makeLight } from '../../helpers/documents';

/**
 * Local storage goes through `documentCodec` like every other entry point. The unversioned
 * flat `RoomState` it has always written still reads, permanently — that is what these cover
 * against the live path rather than against a fixture.
 */
describe('LocalStorage Persistence', () => {
  const mockLocalStorage: Record<string, string> = {};

  const saveInputOf = (document: ReturnType<typeof makeDocument>) => ({
    document,
    carried: {
      ...createEmptyCarriedState(),
      geometryFingerprint: geometryFingerprint(document.geometry),
    },
  });

  beforeEach(() => {
    Object.keys(mockLocalStorage).forEach((key) => delete mockLocalStorage[key]);

    vi.stubGlobal('localStorage', {
      getItem: (key: string) => mockLocalStorage[key] ?? null,
      setItem: (key: string, value: string) => {
        mockLocalStorage[key] = value;
      },
      removeItem: (key: string) => {
        delete mockLocalStorage[key];
      },
      clear: () => {
        Object.keys(mockLocalStorage).forEach((key) => delete mockLocalStorage[key]);
      },
    });
  });

  it('writes a v3 envelope, not the flat legacy shape', () => {
    const doc = makeDocument({
      ceilingHeight: 9,
      walls: [{ id: '1', start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, length: 10 }],
    });

    saveToLocalStorage(saveInputOf(doc));

    const stored = JSON.parse(mockLocalStorage['lumen2d_project']);
    expect(stored.version).toBe(3);
    expect(stored.space.ceilingHeight).toBe(9);
    expect(stored.geometry.boundary.walls).toHaveLength(1);
  });

  it('prunes a module slice that equals its default', () => {
    saveToLocalStorage(saveInputOf(makeDocument()));

    const stored = JSON.parse(mockLocalStorage['lumen2d_project']);
    expect(stored.modules).toEqual({});
  });

  it('restores the unversioned flat shape local storage has always written', () => {
    mockLocalStorage['lumen2d_project'] = JSON.stringify({
      ceilingHeight: 10,
      walls: [],
      lights: [],
      doors: [],
      obstacles: [],
      isClosed: true,
    });

    const restored = loadFromLocalStorage();

    expect(restored).not.toBeNull();
    expect(restored!.document.space.ceilingHeight).toBe(10);
    expect(restored!.document.geometry.boundary.isClosed).toBe(true);
  });

  it('returns null when no saved state exists', () => {
    expect(loadFromLocalStorage()).toBeNull();
  });

  it('clears localStorage', () => {
    mockLocalStorage['lumen2d_project'] = JSON.stringify({ test: true });

    clearLocalStorage();

    expect(mockLocalStorage['lumen2d_project']).toBeUndefined();
  });

  it('handles JSON parse errors gracefully', () => {
    mockLocalStorage['lumen2d_project'] = 'invalid json';

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const restored = loadFromLocalStorage();

    expect(restored).toBeNull();
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('round-trips a document value-identically', () => {
    const doc = makeDocument({
      ceilingHeight: 12,
      walls: [
        { id: 'w1', start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, length: 10 },
        { id: 'w2', start: { x: 10, y: 0 }, end: { x: 10, y: 10 }, length: 10 },
      ],
      lights: [makeLight('l1', { x: 5, y: 5 })],
      isClosed: true,
    });

    saveToLocalStorage(saveInputOf(doc));
    const restored = loadFromLocalStorage();

    expect(restored!.document).toEqual(doc);
    expect(lightsOf(restored!.document)).toHaveLength(1);
  });
});
