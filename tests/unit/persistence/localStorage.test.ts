import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  saveToLocalStorage,
  loadFromLocalStorage,
  clearLocalStorage,
} from '../../../src/persistence/localStorage';
import { makeDocument } from '../../helpers/documents';

describe('LocalStorage Persistence', () => {
  const mockLocalStorage: Record<string, string> = {};

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

  it('saves room state to localStorage', () => {
    const doc = makeDocument({
      ceilingHeight: 9,
      walls: [{ id: '1', start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, length: 10 }],
    });

    saveToLocalStorage(doc);

    const stored = JSON.parse(mockLocalStorage['lumen2d_project']);
    expect(stored.ceilingHeight).toBe(9);
    expect(stored.walls).toHaveLength(1);
  });

  it('restores room state from localStorage', () => {
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
    expect(restored!.space.ceilingHeight).toBe(10);
    expect(restored!.geometry.boundary.isClosed).toBe(true);
  });

  it('returns null when no saved state exists', () => {
    const restored = loadFromLocalStorage();
    expect(restored).toBeNull();
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

  it('preserves all room state properties', () => {
    const doc = makeDocument({
      ceilingHeight: 12,
      walls: [
        { id: 'w1', start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, length: 10 },
        { id: 'w2', start: { x: 10, y: 0 }, end: { x: 10, y: 10 }, length: 10 },
      ],
      lights: [
        {
          id: 'l1',
          position: { x: 5, y: 5 },
          properties: { lumen: 800, beamAngle: 60, warmth: 2700 },
        },
      ],
      isClosed: true,
    });

    saveToLocalStorage(doc);
    const restored = loadFromLocalStorage();

    // The document survives the flat legacy wire shape unchanged
    expect(restored).toEqual(doc);
  });
});
