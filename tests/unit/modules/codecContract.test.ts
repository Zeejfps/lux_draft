import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ModuleCodec } from '../../../src/floorplan/types/module';
import {
  defineCommand,
  readModule,
  withModule,
  hasModuleSlice,
} from '../../../src/floorplan/types/module';
import {
  clearModuleRegistry,
  registerModule,
  registeredCodecs,
  registeredModuleCommands,
} from '../../../src/floorplan/types/moduleRegistry';
import {
  applyCommand,
  commandLabel,
  registeredCommandTypes,
} from '../../../src/floorplan/commands';
import {
  assertCommandIsSerializable,
  valueEqual,
} from '../../../src/floorplan/commands/serializable';
import { installModules } from '../../../src/modules/codecs';
import { lightingCodec } from '../../../src/modules/lighting/codec';
import { lightingCommands } from '../../../src/modules/lighting/commands';
import { COMMAND_SAMPLES, documentWithSlice } from '../../helpers/moduleSamples';

/**
 * The contract every module inherits. A new module passes these or it does not ship — the
 * failures they catch (a shared default drifting the prune baseline, a share link the sender's
 * own decoder rejects, a duplicate id silently shadowing) all surface long after the commit
 * that caused them.
 */

beforeEach(() => {
  clearModuleRegistry();
  installModules();
});

afterEach(() => {
  clearModuleRegistry();
  installModules();
});

describe('codec contract: fresh defaults', () => {
  it('every registered codec allocates a new default on every call', () => {
    for (const codec of registeredCodecs()) {
      const a = codec.defaultData();
      const b = codec.defaultData();
      expect(a, codec.id).not.toBe(b);
      expect(a, codec.id).toEqual(b);
    }
  });

  it('mutating a returned default cannot drift the baseline of the next call', () => {
    for (const codec of registeredCodecs()) {
      const first = codec.defaultData() as Record<string, unknown>;
      for (const key of Object.keys(first)) {
        if (Array.isArray(first[key])) (first[key] as unknown[]).push('poison');
        else if (first[key] && typeof first[key] === 'object') {
          (first[key] as Record<string, unknown>).poison = true;
        }
      }
      expect(codec.defaultData(), codec.id).toEqual(codec.defaultData());
      expect(codec.defaultData(), codec.id).not.toEqual(first);
    }
  });

  it('a default round-trips through its own decoder', () => {
    for (const codec of registeredCodecs()) {
      const result = codec.decode({ v: codec.schemaVersion, data: codec.defaultData() });
      expect(result.status, codec.id).toBe('ok');
      if (result.status === 'ok') expect(result.data).toEqual(codec.defaultData());
    }
  });
});

describe('codec contract: decode is total', () => {
  const hostile: unknown[] = [null, 7, 'text', [], { fixtures: 3 }, { definitions: 'x' }];

  it('never throws, whatever the payload', () => {
    for (const codec of registeredCodecs()) {
      for (const data of hostile) {
        expect(() => codec.decode({ v: codec.schemaVersion, data }), codec.id).not.toThrow();
      }
      expect(() => codec.decode({ v: 9999, data: {} }), codec.id).not.toThrow();
      expect(() => codec.decode({ v: 0, data: {} }), codec.id).not.toThrow();
    }
  });

  it('reports a newer schema version as unsupported, not invalid', () => {
    for (const codec of registeredCodecs()) {
      const result = codec.decode({ v: codec.schemaVersion + 1, data: {} });
      expect(result.status, codec.id).toBe('unsupported');
      if (result.status === 'unsupported') {
        expect(result.writtenVersion).toBe(codec.schemaVersion + 1);
      }
    }
  });
});

describe('codec contract: share round-trip', () => {
  it('compactForShare returns T, so the ordinary decoder reads it back', () => {
    for (const codec of registeredCodecs()) {
      if (!codec.compactForShare) continue;
      const sample = sampleDataFor(codec);
      const compacted = codec.compactForShare(sample);
      const result = codec.decode({ v: codec.schemaVersion, data: compacted });
      expect(result.status, codec.id).toBe('ok');
      if (result.status === 'ok') expect(result.data).toEqual(compacted);
    }
  });

  it('compacting is idempotent', () => {
    for (const codec of registeredCodecs()) {
      if (!codec.compactForShare) continue;
      const once = codec.compactForShare(sampleDataFor(codec));
      expect(codec.compactForShare(once as Readonly<unknown>), codec.id).toEqual(once);
    }
  });
});

/** A non-default slice to compact. Built by applying this module's own sample commands. */
function sampleDataFor<T>(codec: ModuleCodec<T>): Readonly<T> {
  let doc = documentWithSlice(codec, codec.defaultData());
  for (const command of registeredModuleCommands()) {
    if (command.moduleId !== codec.id) continue;
    if (command.verb.endsWith('remove')) continue;
    doc = applyCommand(doc, {
      type: command.type,
      moduleId: command.moduleId,
      payload: COMMAND_SAMPLES[command.type],
    });
  }
  return readModule(doc, codec);
}

describe('registry contract: registration validates and fails fast', () => {
  const stubCodec = (id: string): ModuleCodec<{ n: number }> => ({
    id,
    schemaVersion: 1,
    defaultData: () => ({ n: 0 }),
    decode: (blob) => ({ status: 'ok', data: blob.data as { n: number } }),
  });

  it('rejects a duplicate module id', () => {
    expect(() =>
      registerModule({ codec: stubCodec('lighting'), commands: [], label: 'Stub' })
    ).toThrow(/Duplicate module id/);
  });

  it('re-running the eager barrel is a no-op, not a duplicate', () => {
    const installed = registeredCodecs().length;
    expect(installed).toBeGreaterThan(1); // lighting and flooring: the contract has two subjects
    expect(() => {
      installModules();
      installModules();
    }).not.toThrow();
    expect(registeredCodecs()).toHaveLength(installed);
  });

  it('rejects a command whose type is not namespaced with its module id', () => {
    const codec = stubCodec('stub');
    const stray = defineCommand(lightingCodec, 'oops', {
      label: () => 'oops',
      apply: (_d, _p, prev) => prev,
    });
    expect(() => registerModule({ codec, commands: [stray], label: 'Stub' })).toThrow(/moduleId/);
  });

  it('rejects a duplicate command type', () => {
    const codec = stubCodec('stub');
    const one = defineCommand(codec, 'thing.set', {
      label: () => 'thing',
      apply: (_d, _p, prev) => prev,
    });
    const two = defineCommand(codec, 'thing.set', {
      label: () => 'thing again',
      apply: (_d, _p, prev) => prev,
    });
    expect(() => registerModule({ codec, commands: [one, two], label: 'Stub' })).toThrow(
      /Duplicate command type/
    );
  });

  it('rejects an id containing a dot, which would make command namespacing ambiguous', () => {
    expect(() => registerModule({ codec: stubCodec('a.b'), commands: [], label: 'Stub' })).toThrow(
      /Invalid module id/
    );
  });

  it('module ids and command types are unique across the whole registry', () => {
    const ids = registeredCodecs().map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const types = registeredModuleCommands().map((c) => c.type);
    expect(new Set(types).size).toBe(types.length);
  });

  it('no module command type shadows a core command type', () => {
    const core = new Set<string>(registeredCommandTypes);
    for (const command of registeredModuleCommands()) {
      expect(core.has(command.type), command.type).toBe(false);
    }
  });
});

describe('command contract: serializable, labelled, absolute where it matters', () => {
  it('every registered module command has a sample payload', () => {
    for (const command of registeredModuleCommands()) {
      expect(COMMAND_SAMPLES, command.type).toHaveProperty(command.type);
    }
  });

  it('survives a JSON round-trip value-identically', () => {
    for (const command of registeredModuleCommands()) {
      const value = {
        type: command.type,
        moduleId: command.moduleId,
        payload: COMMAND_SAMPLES[command.type],
      };
      expect(() => assertCommandIsSerializable(value)).not.toThrow();
      expect(valueEqual(JSON.parse(JSON.stringify(value)), value)).toBe(true);
    }
  });

  it('has a non-empty label', () => {
    for (const command of registeredModuleCommands()) {
      const value = {
        type: command.type,
        moduleId: command.moduleId,
        payload: COMMAND_SAMPLES[command.type],
      };
      expect(commandLabel(value).length, command.type).toBeGreaterThan(0);
    }
  });

  it('applying an absolute command twice equals applying it once', () => {
    for (const command of registeredModuleCommands()) {
      if (!command.absolute) continue;
      const codec = registeredCodecs().find((c) => c.id === command.moduleId);
      if (!codec) throw new Error(`no codec for ${command.moduleId}`);
      const base = documentWithSlice(codec, sampleDataFor(codec));
      const value = {
        type: command.type,
        moduleId: command.moduleId,
        payload: COMMAND_SAMPLES[command.type],
      };
      const once = applyCommand(base, value);
      const twice = applyCommand(once, value);
      expect(twice, command.type).toEqual(once);
    }
  });

  it('is dispatched through the registry, so an unregistered type throws', () => {
    const doc = documentWithSlice(lightingCodec, lightingCodec.defaultData());
    expect(() =>
      applyCommand(doc, { type: 'lighting.nope', moduleId: 'lighting', payload: {} })
    ).toThrow(/No handler registered/);
  });
});

describe('withModule / readModule are the only doors', () => {
  it('readModule falls back to a fresh default when the slice is absent', () => {
    const bare = documentWithSlice(lightingCodec, lightingCodec.defaultData());
    const empty = { ...bare, modules: {} };
    expect(hasModuleSlice(empty, lightingCodec)).toBe(false);
    expect(readModule(empty, lightingCodec)).toEqual(lightingCodec.defaultData());
    expect(readModule(empty, lightingCodec)).not.toBe(readModule(empty, lightingCodec));
  });

  it('withModule on an absent (quarantined) slice is a no-op returning the same reference', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const doc = { ...documentWithSlice(lightingCodec, lightingCodec.defaultData()), modules: {} };
    const next = withModule(doc, lightingCodec, () => lightingCodec.defaultData());
    expect(next).toBe(doc);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a module command whose slice is quarantined is a no-op, not a throw', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const doc = { ...documentWithSlice(lightingCodec, lightingCodec.defaultData()), modules: {} };
    const command = lightingCommands[1];
    const next = applyCommand(doc, {
      type: command.type,
      moduleId: command.moduleId,
      payload: COMMAND_SAMPLES[command.type],
    });
    expect(next).toBe(doc);
    warn.mockRestore();
  });

  it('rejects a slice that is not plain data, at the write rather than at the save', () => {
    const doc = documentWithSlice(lightingCodec, lightingCodec.defaultData());
    expect(() =>
      withModule(doc, lightingCodec, (prev) => ({
        ...prev,
        fixtures: new Map() as unknown as [],
      }))
    ).toThrow(/not serializable data/);
  });

  it('freezes the slice it writes, so a later in-place edit throws instead of losing history', () => {
    const doc = documentWithSlice(lightingCodec, lightingCodec.defaultData());
    const next = withModule(doc, lightingCodec, (prev) => ({ ...prev, fixtures: [] }));
    expect(Object.isFrozen(readModule(next, lightingCodec))).toBe(true);
  });

  it('withModule leaves geometry and every other slice untouched', () => {
    const doc = documentWithSlice(lightingCodec, lightingCodec.defaultData());
    const next = withModule(doc, lightingCodec, (prev) => ({ ...prev, fixtures: [] }));
    expect(next.geometry).toBe(doc.geometry);
    expect(next.space).toBe(doc.space);
    expect(next).not.toBe(doc);
  });
});
