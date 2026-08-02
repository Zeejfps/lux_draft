import { describe, it, expect, beforeEach } from 'vitest';
import type { LightingData } from '../../../src/modules/lighting/codec';
import type { LoadedDocument } from '../../../src/types/session';
import { lightingCodec, resolveDefinition } from '../../../src/modules/lighting/codec';
import { installModules } from '../../../src/modules/codecs';
import { clearModuleRegistry } from '../../../src/types/moduleRegistry';
import { hasModuleSlice, readModule } from '../../../src/types/module';
import { decodeDocument, encodeDocument } from '../../../src/persistence/documentCodec';
import { toEnvelopeV3 } from '../../../src/persistence/envelope';
import { ValidationError } from '../../../src/persistence/ValidationError';
import { valueEqual } from '../../../src/commands/serializable';
import { applyCommand } from '../../../src/commands';
import { DEFAULT_RAFTER_CONFIG } from '../../../src/types/state';
import { loadFixture } from '../../fixtures/load';

/**
 * Fixture-driven proof of the load pipeline. The fixtures were written before this file, and
 * they are shapes real builds have written — a failure here is a decoder bug, never a fixture
 * bug.
 */

beforeEach(() => {
  clearModuleRegistry();
  installModules();
});

const lighting = (loaded: LoadedDocument): Readonly<LightingData> =>
  readModule(loaded.document, lightingCodec);

const V3_GEOMETRY_ONLY = {
  version: 3,
  geometry: { boundary: { walls: [], isClosed: false }, doors: [], obstacles: [] },
  space: { ceilingHeight: 8 },
  modules: {},
};

// ============================================
// Legacy envelope readers (permanent)
// ============================================

describe('unversioned flat RoomState — what local storage has always written', () => {
  it('nests geometry, lifts ceilingHeight into space, lifts lights into modules.lighting', () => {
    const loaded = decodeDocument(loadFixture('legacy-flat.json'));

    expect(loaded.document.geometry.boundary.walls).toHaveLength(4);
    expect(loaded.document.geometry.boundary.isClosed).toBe(true);
    expect(loaded.document.geometry.obstacles).toEqual([]);
    expect(loaded.document.space).toEqual({ ceilingHeight: 8 });

    expect(lighting(loaded).fixtures).toHaveLength(1);
    expect(lighting(loaded).fixtures[0].id).toBe('light-1');
    expect(lighting(loaded).rafterConfig).toEqual(DEFAULT_RAFTER_CONFIG);
    expect(lighting(loaded).definitions).toEqual([]);

    expect(loaded.carried.quarantined).toEqual({});
    expect(loaded.diagnostics.warnings).toEqual([]);
  });

  it('migrates a door written before swing sides existed', () => {
    const loaded = decodeDocument(loadFixture('legacy-flat.json'));
    expect(loaded.document.geometry.doors[0].swingSide).toBe('inside');
  });
});

describe('envelope v1', () => {
  it('migrates to the target shape with defaults materialized', () => {
    const loaded = decodeDocument(loadFixture('envelope-v1.json'));

    expect(loaded.document.space.ceilingHeight).toBe(9);
    expect(loaded.document.geometry.doors).toEqual([]);
    expect(loaded.document.geometry.obstacles).toEqual([]);

    const data = lighting(loaded);
    expect(data.fixtures.map((f) => f.id)).toEqual(['light-1', 'light-2']);
    // A built-in definition id needs no closure entry; built-ins resolve by id.
    expect(data.definitions).toEqual([]);
    expect(data.deadZone).toEqual(lightingCodec.defaultData().deadZone);
    expect(data.spacing).toEqual(lightingCodec.defaultData().spacing);

    expect(loaded.carried.quarantined).toEqual({});
    expect(loaded.carried.geometryFingerprint).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('envelope v2', () => {
  it('carries doors, obstacles, rafters and display preferences across', () => {
    const loaded = decodeDocument(loadFixture('envelope-v2.json'));

    expect(loaded.document.space.ceilingHeight).toBe(9.5);
    expect(loaded.document.geometry.doors).toEqual([
      {
        id: 'door-1',
        wallId: 'w1',
        position: 4,
        width: 3,
        swingDirection: 'right',
        swingSide: 'outside',
      },
    ]);
    expect(loaded.document.geometry.obstacles).toHaveLength(1);
    expect(loaded.document.geometry.obstacles[0].walls).toHaveLength(4);

    expect(loaded.document.displayPreferences?.unitFormat).toBe('inches');
    expect(loaded.document.displayPreferences?.lightRadiusVisibility).toBe('always');

    // rafterConfig lands in the module slice, not at the document root.
    expect(lighting(loaded).rafterConfig).toEqual({
      orientation: 'vertical',
      spacing: 2,
      offsetX: 0.5,
      offsetY: 0,
      visible: true,
    });
  });
});

// ============================================
// The conflicting-definition case
// ============================================

describe('a v2 file with a referenced custom- definition', () => {
  const CONFLICTING_LOCAL = {
    id: 'custom-alpha',
    name: 'My local Alpha',
    lumen: 200,
    beamAngle: 120,
    warmth: 2200,
  };

  it("keeps the document's photometry, not the local library's", () => {
    const loaded = decodeDocument(loadFixture('envelope-v2-custom-definition.json'));
    const data = lighting(loaded);

    expect(data.definitions).toEqual([
      { id: 'custom-alpha', name: "Sender's Alpha Spot", lumen: 1234, beamAngle: 33, warmth: 4200 },
    ]);

    // The library holds a *different* definition under the same id — the exact shape of the
    // bug this replaces, where import merged only ids not already present and the recipient's
    // photometry silently won.
    const resolved = resolveDefinition(data, 'custom-alpha', [CONFLICTING_LOCAL]);
    expect(resolved).toEqual(data.definitions[0]);
    expect(resolved?.lumen).toBe(1234);
  });

  it('falls back to the library only for an id the document does not carry', () => {
    const loaded = decodeDocument(loadFixture('envelope-v2-custom-definition.json'));
    const other = { ...CONFLICTING_LOCAL, id: 'custom-beta' };
    expect(resolveDefinition(lighting(loaded), 'custom-beta', [other])).toEqual(other);
  });

  it('drops definitions no fixture references, so the closure stays closed', () => {
    const loaded = decodeDocument(loadFixture('envelope-v2-custom-definition.json'));
    expect(lighting(loaded).definitions.map((d) => d.id)).toEqual(['custom-alpha']);
  });

  it('decode is pure: it merges nothing into any store', () => {
    const raw = loadFixture('envelope-v2-custom-definition.json') as Record<string, unknown>;
    const before = JSON.stringify(raw);
    decodeDocument(raw);
    expect(JSON.stringify(raw)).toBe(before);
  });
});

// ============================================
// Quarantine
// ============================================

describe('quarantine: a module blob written by a newer build', () => {
  it('is unsupported, not live, and warns', () => {
    const loaded = decodeDocument(loadFixture('envelope-v3-future-module.json'));

    expect(hasModuleSlice(loaded.document, lightingCodec)).toBe(false);
    expect(loaded.carried.quarantined.lighting.reason).toBe('unsupported');
    expect(loaded.carried.quarantined.lighting.blob.v).toBe(99);
    expect(loaded.diagnostics.warnings).toHaveLength(1);
    expect(loaded.diagnostics.warnings[0].message).toMatch(/newer version/);
  });

  it('leaves geometry fully usable — only geometry failure rejects a document', () => {
    const loaded = decodeDocument(loadFixture('envelope-v3-future-module.json'));
    expect(loaded.document.geometry.boundary.walls).toHaveLength(4);
    const edited = applyCommand(loaded.document, { type: 'space.setCeilingHeight', height: 10 });
    expect(edited.space.ceilingHeight).toBe(10);
  });
});

describe('quarantine: a corrupt blob', () => {
  it('is invalid and carries the codec message', () => {
    const loaded = decodeDocument(loadFixture('envelope-v3-corrupt-blob.json'));
    expect(loaded.carried.quarantined.lighting.reason).toBe('invalid');
    expect(loaded.carried.quarantined.lighting.message).toMatch(/fixtures must be an array/);
    expect(loaded.diagnostics.warnings[0].message).toMatch(/could not be read/);
  });
});

describe('quarantine: an unknown module id', () => {
  it('is preserved with no warning — expected in a single-module build', () => {
    const loaded = decodeDocument(loadFixture('envelope-v3-unknown-module.json'));
    expect(loaded.carried.quarantined.flooring.reason).toBe('unknownModule');
    expect(loaded.carried.quarantined.flooring.message).toBeUndefined();
    expect(loaded.diagnostics.warnings).toEqual([]);
    // The module this build *does* know stays live alongside it.
    expect(hasModuleSlice(loaded.document, lightingCodec)).toBe(true);
    expect(lighting(loaded).fixtures).toHaveLength(1);
  });

  it('puts every id in exactly one of the two maps', () => {
    const loaded = decodeDocument(loadFixture('envelope-v3-unknown-module.json'));
    for (const id of Object.keys(loaded.carried.quarantined)) {
      expect(hasModuleSlice(loaded.document, { ...lightingCodec, id })).toBe(false);
    }
  });
});

describe('only geometry validation rejects', () => {
  it('throws ValidationError on a missing boundary', () => {
    expect(() => decodeDocument({ version: 3, geometry: {}, modules: {} })).toThrow(
      ValidationError
    );
  });

  it('throws ValidationError on a non-object', () => {
    expect(() => decodeDocument('not a document')).toThrow(ValidationError);
    expect(() => decodeDocument(null)).toThrow(ValidationError);
  });

  it('throws ValidationError on a malformed wall', () => {
    const raw = loadFixture('envelope-v2.json') as { roomState: { walls: unknown[] } };
    raw.roomState.walls[0] = { id: 'w1', start: { x: 0 }, end: { x: 1, y: 1 }, length: 1 };
    expect(() => decodeDocument(raw)).toThrow(ValidationError);
  });

  it('quarantines rather than rejects when only the lighting payload is broken', () => {
    const raw = loadFixture('legacy-flat.json') as { lights: unknown };
    raw.lights = [{ id: 'l1', position: { x: 0, y: 0 }, properties: { lumen: 'lots' } }];
    const loaded = decodeDocument(raw);
    expect(loaded.carried.quarantined.lighting.reason).toBe('invalid');
    expect(loaded.document.geometry.boundary.walls).toHaveLength(4);
  });
});

// ============================================
// Normalize on load, prune on save
// ============================================

describe('normalize on load / prune on save', () => {
  it('materializes a default for a module the document has no blob for', () => {
    const loaded = decodeDocument(V3_GEOMETRY_ONLY);
    expect(hasModuleSlice(loaded.document, lightingCodec)).toBe(true);
    expect(lighting(loaded)).toEqual(lightingCodec.defaultData());
  });

  it('freezes what it returns in dev, so nothing can drift the normalized baseline', () => {
    const loaded = decodeDocument(loadFixture('envelope-v3-unknown-module.json'));
    expect(Object.isFrozen(loaded.document.geometry.boundary.walls)).toBe(true);
    expect(Object.isFrozen(lighting(loaded))).toBe(true);
    expect(Object.isFrozen(loaded.carried.quarantined.flooring.blob.data)).toBe(true);
  });

  it('omits a slice that deep-equals a freshly allocated default', () => {
    const loaded = decodeDocument(V3_GEOMETRY_ONLY);
    const envelope = encodeDocument(loaded.document, loaded.carried, { kind: 'local' });
    expect(envelope.modules).toEqual({});
  });

  it('an empty mode visit is not an edit: load → save → load is value-identical', () => {
    const first = decodeDocument(loadFixture('envelope-v2.json'));
    const saved = encodeDocument(first.document, first.carried, { kind: 'file' });
    const second = decodeDocument(saved);
    expect(second.document).toEqual(first.document);
    expect(second.carried.geometryFingerprint).toBe(first.carried.geometryFingerprint);
    expect(encodeDocument(second.document, second.carried, { kind: 'file' })).toEqual(saved);
  });

  it('writes a non-default slice at the codec schema version', () => {
    const loaded = decodeDocument(loadFixture('envelope-v1.json'));
    const envelope = encodeDocument(loaded.document, loaded.carried, { kind: 'file' });
    expect(envelope.version).toBe(3);
    expect(envelope.modules.lighting.v).toBe(lightingCodec.schemaVersion);
    expect((envelope.modules.lighting.data as LightingData).fixtures).toHaveLength(2);
  });
});

// ============================================
// Merge precedence and drift
// ============================================

describe('merge precedence: quarantined vs live', () => {
  it('file/local merge quarantined blobs back verbatim', () => {
    const raw = loadFixture('envelope-v3-unknown-module.json') as {
      modules: Record<string, unknown>;
    };
    const loaded = decodeDocument(raw);
    const envelope = encodeDocument(loaded.document, loaded.carried, { kind: 'file' });
    expect(envelope.modules.flooring).toEqual(raw.modules.flooring);
  });

  it('quarantined blobs round-trip value-identically through decode → encode → decode', () => {
    for (const name of ['envelope-v3-unknown-module.json', 'envelope-v3-future-module.json']) {
      const first = decodeDocument(loadFixture(name));
      expect(Object.keys(first.carried.quarantined), name).not.toEqual([]);
      const envelope = encodeDocument(first.document, first.carried, { kind: 'file' });
      const second = decodeDocument(envelope);
      // Not byte-identical — the blob has been through JSON.parse, so key order, whitespace,
      // escapes and numeric spelling may change. Preserving the JSON *value* is the contract.
      expect(valueEqual(second.carried.quarantined, first.carried.quarantined), name).toBe(true);
      const third = decodeDocument(
        encodeDocument(second.document, second.carried, { kind: 'local' })
      );
      expect(valueEqual(third.carried.quarantined, first.carried.quarantined), name).toBe(true);
    }
  });

  it('records no drift flag when geometry has not changed since load', () => {
    const loaded = decodeDocument(loadFixture('envelope-v3-unknown-module.json'));
    const envelope = encodeDocument(loaded.document, loaded.carried, { kind: 'local' });
    expect(envelope.quarantineFlags).toEqual({ flooring: { geometryChangedSinceLoad: false } });
  });

  it('records the drift flag once a geometry command has landed', () => {
    const loaded = decodeDocument(loadFixture('envelope-v3-unknown-module.json'));
    const edited = applyCommand(loaded.document, {
      type: 'vertex.move',
      index: 0,
      position: { x: -1, y: -1 },
    });
    const envelope = encodeDocument(edited, loaded.carried, { kind: 'local' });
    expect(envelope.quarantineFlags).toEqual({ flooring: { geometryChangedSinceLoad: true } });
  });

  it('a non-geometry edit does not set the drift flag', () => {
    const loaded = decodeDocument(loadFixture('envelope-v3-unknown-module.json'));
    const edited = applyCommand(loaded.document, { type: 'space.setCeilingHeight', height: 12 });
    const envelope = encodeDocument(edited, loaded.carried, { kind: 'local' });
    expect(envelope.quarantineFlags?.flooring.geometryChangedSinceLoad).toBe(false);
  });

  it('omits quarantineFlags entirely when nothing is quarantined', () => {
    const loaded = decodeDocument(loadFixture('envelope-v1.json'));
    expect(
      encodeDocument(loaded.document, loaded.carried, { kind: 'file' }).quarantineFlags
    ).toBeUndefined();
  });
});

// ============================================
// Share
// ============================================

describe('share encoding is a single-module view', () => {
  it('omits quarantined blobs and every non-target slice', () => {
    const loaded = decodeDocument(loadFixture('envelope-v3-unknown-module.json'));
    const envelope = encodeDocument(loaded.document, loaded.carried, {
      kind: 'share',
      moduleId: 'lighting',
    });
    expect(Object.keys(envelope.modules)).toEqual(['lighting']);
    expect(envelope.quarantineFlags).toBeUndefined();
  });

  it('compacts the target and the recipient reads it back with the ordinary decoder', () => {
    const loaded = decodeDocument(loadFixture('envelope-v2-custom-definition.json'));
    const envelope = encodeDocument(loaded.document, loaded.carried, {
      kind: 'share',
      moduleId: 'lighting',
    });
    const received = decodeDocument(envelope);
    expect(received.carried.quarantined).toEqual({});
    expect(lighting(received).fixtures.map((f) => f.id)).toEqual(['light-1', 'light-2']);
    // The definition closure travels with the link; that is the whole point.
    expect(lighting(received).definitions).toEqual(lighting(loaded).definitions);
    expect(lighting(received).deadZone).toEqual(lightingCodec.defaultData().deadZone);
  });

  it('refuses to share a module whose data is quarantined', () => {
    const loaded = decodeDocument(loadFixture('envelope-v3-future-module.json'));
    expect(() =>
      encodeDocument(loaded.document, loaded.carried, { kind: 'share', moduleId: 'lighting' })
    ).toThrow(/cannot be shared/);
  });
});

// ============================================
// Envelope normalization
// ============================================

describe('toEnvelopeV3', () => {
  it('coerces a structurally broken module entry instead of dropping it', () => {
    const envelope = toEnvelopeV3({ ...V3_GEOMETRY_ONLY, modules: { weird: 42 } });
    expect(envelope.modules.weird).toEqual({ v: 0, data: 42 });
  });

  it('passes a v3 envelope through with its module map intact', () => {
    const raw = loadFixture('envelope-v3-unknown-module.json') as { modules: unknown };
    expect(toEnvelopeV3(raw).modules).toEqual(raw.modules);
  });
});
