import { describe, it, expect } from 'vitest';
import { getJSONString } from '../../../src/floorplan/persistence/jsonExport';
import { ValidationError, importFromString } from '../../../src/floorplan/persistence/jsonImport';
import { createEmptyCarriedState } from '../../../src/floorplan/types/session';
import { geometryFingerprint } from '../../../src/floorplan/persistence/documentCodec';
import { lightsOf, makeDocument, makeLight, rectWalls } from '../../helpers/documents';

/**
 * Export and import both go through the one document codec. The old `ExportData` wrapper
 * (`{ version: 1 | 2, roomState, lightDefinitions }`) is gone from the write path and
 * permanent on the read path.
 */
const saveInputOf = (document: ReturnType<typeof makeDocument>) => ({
  document,
  carried: {
    ...createEmptyCarriedState(),
    geometryFingerprint: geometryFingerprint(document.geometry),
  },
});

describe('JSON Export/Import', () => {
  describe('getJSONString', () => {
    it('exports a v3 envelope with the lighting slice at its own schema version', () => {
      const doc = makeDocument({
        walls: rectWalls(10, 10),
        lights: [makeLight('1', { x: 5, y: 5 })],
        isClosed: true,
      });

      const parsed = JSON.parse(getJSONString(saveInputOf(doc)));

      expect(parsed.version).toBe(3);
      expect(parsed.modules.lighting.v).toBe(1);
      expect(parsed.modules.lighting.data.fixtures[0].properties.lumen).toBe(800);
      expect(parsed.space.ceilingHeight).toBe(8);
    });

    it('omits a slice equal to a freshly allocated default', () => {
      const parsed = JSON.parse(getJSONString(saveInputOf(makeDocument())));
      expect(parsed.modules).toEqual({});
    });

    it('produces formatted output', () => {
      const json = getJSONString(saveInputOf(makeDocument()));

      expect(json).toContain('\n');
      expect(json).toContain('  ');
    });
  });

  describe('importFromString', () => {
    it('imports the legacy flat RoomState', () => {
      const result = importFromString(
        JSON.stringify({ ceilingHeight: 10, walls: [], lights: [], isClosed: false })
      );

      expect(result.document.space.ceilingHeight).toBe(10);
    });

    it('imports the versioned wrapper, lifting lights into the module slice', () => {
      const result = importFromString(
        JSON.stringify({
          version: 1,
          roomState: {
            ceilingHeight: 12,
            walls: [],
            lights: [makeLight('1', { x: 1, y: 1 })],
            isClosed: true,
          },
          lightDefinitions: [],
        })
      );

      expect(result.document.space.ceilingHeight).toBe(12);
      expect(result.document.geometry.boundary.isClosed).toBe(true);
      expect(lightsOf(result.document)).toHaveLength(1);
    });

    it('round-trips an exported file value-identically', () => {
      const doc = makeDocument({
        walls: rectWalls(10, 10),
        lights: [makeLight('1', { x: 5, y: 5 })],
        isClosed: true,
      });

      const reloaded = importFromString(getJSONString(saveInputOf(doc)));

      expect(reloaded.document).toEqual(doc);
    });

    it('throws on invalid JSON', () => {
      expect(() => importFromString('not json')).toThrow(ValidationError);
    });

    it('throws on a document with no usable geometry', () => {
      expect(() => importFromString('{"invalid": true}')).toThrow(ValidationError);
    });

    it('quarantines a broken lights array instead of rejecting the geometry', () => {
      // Deliberate behaviour change from phase 3a: geometry is the shared asset, and one
      // module's undecodable blob may not block it (invariant 8).
      const result = importFromString(
        JSON.stringify({
          ceilingHeight: 8,
          walls: [],
          lights: [{ id: '1', position: { x: 5, y: 5 }, properties: { lumen: -100 } }],
          isClosed: true,
        })
      );

      expect(result.document.space.ceilingHeight).toBe(8);
      expect(result.carried.quarantined.lighting?.reason).toBe('invalid');
    });
  });
});
