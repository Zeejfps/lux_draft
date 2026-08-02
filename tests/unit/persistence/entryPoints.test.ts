import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import type { LightingData } from '../../../src/modules/lighting/codec';
import { LIGHTING_MODULE_ID, lightingCodec } from '../../../src/modules/lighting/codec';
import { moduleSliceIds, readModule } from '../../../src/types/module';
import type { EditorDocument } from '../../../src/types/document';
import type { LoadedDocument, SaveInput } from '../../../src/types/session';
import { importFromString } from '../../../src/persistence/jsonImport';
import { getJSONString } from '../../../src/persistence/jsonExport';
import { decodeShareData, generateShareUrl } from '../../../src/persistence/shareUrl';
import { loadFromLocalStorage, saveToLocalStorage } from '../../../src/persistence/localStorage';
import { sessionStore, saveInput } from '../../../src/stores/sessionStore';
import { openLoaded } from '../../../src/stores/roomStore';
import { fixtures, rafterConfig, toggleRafters } from '../../../src/stores/lightingStore';
import { lightDefinitions } from '../../../src/stores/lightDefinitionsStore';
import { adoptIncomingDefinitions } from '../../../src/stores/lightingStore';
import { DEFAULT_LIGHT_DEFINITIONS } from '../../../src/types/lighting';
import { loadFixture } from '../../fixtures/load';

/**
 * Phase 3b's acceptance criteria, asserted against the **live** entry points rather than
 * against `decodeDocument` directly: every import, local-storage read, share link and export
 * goes through the one codec (invariant 9), and every load ends in `sessionStore.open`.
 *
 * The phase-3a fixtures are the regression gate — `documentCodec.test.ts` proves the decoder,
 * this file proves the paths that reach it.
 */

const FIXTURES = [
  'legacy-flat.json',
  'envelope-v1.json',
  'envelope-v2.json',
  'envelope-v2-custom-definition.json',
  'envelope-v3-future-module.json',
  'envelope-v3-corrupt-blob.json',
  'envelope-v3-unknown-module.json',
];

const lightingOf = (doc: EditorDocument): Readonly<LightingData> => readModule(doc, lightingCodec);

const saveInputOf = (loaded: LoadedDocument): SaveInput => ({
  document: loaded.document,
  carried: loaded.carried,
});

const mockStorage: Record<string, string> = {};

beforeEach(() => {
  Object.keys(mockStorage).forEach((key) => delete mockStorage[key]);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => mockStorage[key] ?? null,
    setItem: (key: string, value: string) => {
      mockStorage[key] = value;
    },
    removeItem: (key: string) => {
      delete mockStorage[key];
    },
  });
  lightDefinitions.set([...DEFAULT_LIGHT_DEFINITIONS]);
});

// ============================================
// The fixtures, through the live paths
// ============================================

describe('every entry point reads the phase-3a fixtures', () => {
  for (const name of FIXTURES) {
    it(`importFromString reads ${name}`, () => {
      const loaded = importFromString(JSON.stringify(loadFixture(name)));
      expect(loaded.document.geometry.boundary.walls).toBeInstanceOf(Array);
      // Decode puts each module id in exactly one of the two maps.
      for (const id of Object.keys(loaded.carried.quarantined)) {
        expect(moduleSliceIds(loaded.document), id).not.toContain(id);
      }
    });

    it(`localStorage reads ${name} and writes it back losslessly`, () => {
      mockStorage['lumen2d_project'] = JSON.stringify(loadFixture(name));
      const loaded = loadFromLocalStorage()!;
      expect(loaded).not.toBeNull();

      saveToLocalStorage(saveInputOf(loaded));
      const reloaded = loadFromLocalStorage()!;

      expect(reloaded.document).toEqual(loaded.document);
      expect(reloaded.carried.quarantined).toEqual(loaded.carried.quarantined);
    });
  }
});

// ============================================
// Acceptance: load → visit a mode → save is value-identical
// ============================================

describe('load → visit a mode → save', () => {
  for (const name of FIXTURES) {
    it(`${name} survives a session round-trip value-identically`, () => {
      const loaded = importFromString(JSON.stringify(loadFixture(name)));
      openLoaded(loaded);

      // "Visit a mode": read every lighting projection. Reads are ordinary field reads
      // because decode normalized a default in, so this must not be an edit.
      const documentBefore = get(saveInput).document;
      void get(fixtures);
      void get(rafterConfig);
      expect(get(saveInput).document).toBe(documentBefore);
      expect(get(sessionStore).history.past).toHaveLength(0);

      const saved = importFromString(getJSONString(get(saveInput)));
      expect(saved.document).toEqual(loaded.document);
      expect(saved.carried.quarantined).toEqual(loaded.carried.quarantined);
    });
  }

  it('a slice equal to its default is pruned from the envelope', () => {
    openLoaded(importFromString(JSON.stringify(loadFixture('envelope-v1.json'))));
    const withFixtures = JSON.parse(getJSONString(get(saveInput)));
    expect(withFixtures.modules.lighting).toBeDefined();

    // A brand-new project has a materialized default slice and must serialize without it.
    sessionStore.open({
      document: importFromString('{"ceilingHeight":8,"walls":[],"lights":[],"isClosed":false}')
        .document,
      carried: { quarantined: {}, geometryFingerprint: '' },
      diagnostics: { warnings: [], runtimeStatus: {} },
    });
    expect(JSON.parse(getJSONString(get(saveInput))).modules).toEqual({});
  });

  it('an edit after load lands in the slice and survives the round-trip', () => {
    openLoaded(importFromString(JSON.stringify(loadFixture('envelope-v1.json'))));

    toggleRafters();
    const visible = get(rafterConfig).visible;

    const reloaded = importFromString(getJSONString(get(saveInput)));
    expect(lightingOf(reloaded.document).rafterConfig.visible).toBe(visible);
  });
});

// ============================================
// Share links
// ============================================

describe('share links', () => {
  it('round-trips through generate → decode, compacted to the target module', () => {
    const loaded = importFromString(JSON.stringify(loadFixture('envelope-v2.json')));
    openLoaded(loaded);

    const result = generateShareUrl(get(saveInput), LIGHTING_MODULE_ID);
    const encoded = result.url.split('?d=')[1];
    const reopened = decodeShareData(encoded);

    expect(reopened.document.geometry).toEqual(loaded.document.geometry);
    expect(lightingOf(reopened.document).fixtures).toEqual(lightingOf(loaded.document).fixtures);
    // `compactForShare` drops authoring-only settings, so they come back as defaults.
    expect(lightingOf(reopened.document).deadZone).toEqual(lightingCodec.defaultData().deadZone);
  });

  it('carries a custom definition, so the recipient renders the sender photometry', () => {
    const loaded = importFromString(
      JSON.stringify(loadFixture('envelope-v2-custom-definition.json'))
    );
    openLoaded(loaded);

    const encoded = generateShareUrl(get(saveInput), LIGHTING_MODULE_ID).url.split('?d=')[1];
    const reopened = decodeShareData(encoded);

    expect(lightingOf(reopened.document).definitions).toEqual(
      lightingOf(loaded.document).definitions
    );
    expect(lightingOf(reopened.document).definitions.length).toBeGreaterThan(0);
  });

  it('refuses to share a module whose data this build could not decode', () => {
    const loaded = importFromString(JSON.stringify(loadFixture('envelope-v3-corrupt-blob.json')));
    openLoaded(loaded);

    expect(() => generateShareUrl(get(saveInput), LIGHTING_MODULE_ID)).toThrow(/cannot be shared/);
  });

  it('rejects a corrupted payload rather than opening an empty document', () => {
    expect(() => decodeShareData('not-compressed-data')).toThrow();
  });
});

// ============================================
// Definition adoption
// ============================================

describe('adoptIncomingDefinitions', () => {
  it('offers an unknown incoming definition to the picker library', () => {
    const loaded = importFromString(
      JSON.stringify(loadFixture('envelope-v2-custom-definition.json'))
    );
    openLoaded(loaded);
    adoptIncomingDefinitions(loaded.document);

    const incoming = lightingOf(loaded.document).definitions[0];
    expect(get(lightDefinitions).some((d) => d.id === incoming.id)).toBe(true);
  });

  it('never overwrites a local definition of the same id — the document keeps its own', () => {
    const loaded = importFromString(
      JSON.stringify(loadFixture('envelope-v2-custom-definition.json'))
    );
    const incoming = lightingOf(loaded.document).definitions[0];
    const localConflict = { ...incoming, name: 'Mine', lumen: incoming.lumen + 1000 };
    lightDefinitions.set([...DEFAULT_LIGHT_DEFINITIONS, localConflict]);

    openLoaded(loaded);
    adoptIncomingDefinitions(loaded.document);

    expect(get(lightDefinitions).filter((d) => d.id === incoming.id)).toEqual([localConflict]);
    // The document's copy is the one that renders.
    expect(lightingOf(loaded.document).definitions[0]).toEqual(incoming);
  });

  it('is a no-op for a document that references no custom definition', () => {
    const before = get(lightDefinitions);
    adoptIncomingDefinitions(
      importFromString(JSON.stringify(loadFixture('envelope-v1.json'))).document
    );
    expect(get(lightDefinitions)).toBe(before);
  });
});
