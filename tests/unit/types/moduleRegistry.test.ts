import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ModuleCodec } from '../../../src/floorplan/types/module';
import type { ModuleRuntime, ToolDescriptor } from '../../../src/floorplan/types/moduleRuntime';
import {
  CORE_RESERVED_SHORTCUTS,
  shortcutBindingKey,
} from '../../../src/floorplan/types/moduleRuntime';
import {
  claimCoreLayerIds,
  claimCorePanelKeys,
  claimLayerIds,
  clearModuleRegistry,
  registerModule,
  validateRuntime,
} from '../../../src/floorplan/types/moduleRegistry';
import { createDefaultKeyboardShortcuts } from '../../../src/floorplan/interactions/KeyboardShortcutManager';
import { defineSelection } from '../../../src/floorplan/types/selection';
import { installModules } from '../../../src/modules/codecs';

/**
 * Registration validates and fails fast.
 *
 * A duplicate string shadows silently and surfaces much later — as the wrong panel rendering
 * for a selection, or a shortcut firing another module's action. Every check below throws at
 * the moment the contribution is registered instead.
 */

const stubCodec = (id: string): ModuleCodec<{ n: number }> => ({
  id,
  schemaVersion: 1,
  defaultData: () => ({ n: 0 }),
  decode: (blob) => ({ status: 'ok', data: blob.data as { n: number } }),
});

function install(id: string): void {
  registerModule({ codec: stubCodec(id), commands: [], label: id });
}

function runtime(id: string, extra: Partial<ModuleRuntime> = {}): ModuleRuntime {
  return { id, label: id, ...extra };
}

const tool = (id: string): ToolDescriptor => ({ id, label: id, title: id, icon: '' });

beforeEach(() => {
  clearModuleRegistry();
});

afterEach(() => {
  clearModuleRegistry();
  installModules();
});

describe('runtime registration', () => {
  it('rejects a runtime with no registered module', () => {
    expect(() => validateRuntime(runtime('ghost'))).toThrow(/no registered module definition/);
  });

  it('rejects a runtime whose id disagrees with its codec', () => {
    install('alpha');
    // A runtime that names another module's id is caught by the lookup, which is the same
    // failure: nothing may claim contributions under an id it does not own.
    expect(() => validateRuntime(runtime('beta'))).toThrow(/no registered module definition/);
  });

  it('rejects a tool id that is not namespaced with the module id', () => {
    install('alpha');
    expect(() => validateRuntime(runtime('alpha', { tools: [tool('light')] }))).toThrow(
      /not namespaced/
    );
  });

  it('rejects a duplicate tool id within one module', () => {
    install('alpha');
    expect(() =>
      validateRuntime(runtime('alpha', { tools: [tool('alpha.a'), tool('alpha.a')] }))
    ).toThrow(/Duplicate tool id/);
  });

  it('rejects a tool id claimed by another module', () => {
    install('alpha');
    install('beta');
    validateRuntime(runtime('alpha', { tools: [tool('alpha.place')] }));
    // A module may not claim a string another module owns, even under its own namespace.
    expect(() => validateRuntime(runtime('beta', { tools: [tool('alpha.place')] }))).toThrow(
      /not namespaced/
    );
  });

  it('rejects a panel key claimed by another module', () => {
    install('alpha');
    install('beta');
    validateRuntime(runtime('alpha', { panels: { 'alpha.thing': null as never } }));
    expect(() =>
      validateRuntime(runtime('beta', { panels: { 'alpha.thing': null as never } }))
    ).toThrow(/Duplicate panel key/);
  });

  it('rejects a panel key core already owns', () => {
    install('alpha');
    claimCorePanelKeys(['core.wall']);
    expect(() =>
      validateRuntime(runtime('alpha', { panels: { 'core.wall': null as never } }))
    ).toThrow(/Duplicate panel key/);
  });

  it('rejects a duplicate layer id, including against core', () => {
    install('alpha');
    install('beta');
    claimCoreLayerIds(['core.walls']);
    expect(() => claimLayerIds('alpha', ['core.walls'])).toThrow(/Duplicate layer id/);
    claimLayerIds('alpha', ['alpha.one']);
    expect(() => claimLayerIds('beta', ['alpha.one'])).toThrow(/Duplicate layer id/);
    expect(() => claimLayerIds('beta', ['beta.x', 'beta.x'])).toThrow(/Duplicate layer id/);
  });

  it('re-validating and re-claiming the same runtime is a no-op', () => {
    install('alpha');
    const r = runtime('alpha', { tools: [tool('alpha.place')] });
    validateRuntime(r);
    expect(() => validateRuntime(r)).not.toThrow();
    expect(() => claimLayerIds('alpha', ['alpha.one'])).not.toThrow();
    expect(() => claimLayerIds('alpha', ['alpha.one'])).not.toThrow();
  });

  it('rejects entities selected under another module id', () => {
    install('alpha');
    const foreign = defineSelection<{ ids: string[] }>('beta', 'thing', (p) => p as never);
    expect(() =>
      validateRuntime(
        runtime('alpha', {
          entities: {
            selection: foreign,
            hitTolerance: 1,
            list: () => [],
            moveCommand: () => ({ type: 'compound', label: '', commands: [] }),
            removeCommand: () => null,
          },
        })
      )
    ).toThrow(/belongs to another module/);
  });
});

describe('shortcut precedence: core wins over modules', () => {
  it('refuses a shortcut the core shell already binds', () => {
    install('alpha');
    for (const binding of ['m', 'escape', 'ctrl+z']) {
      const [key, ...mods] = binding.split('+').reverse();
      expect(() =>
        validateRuntime(
          runtime('alpha', {
            shortcuts: [{ key, ctrlKey: mods.includes('ctrl'), run: () => {} }],
          })
        )
      ).toThrow(/core shell/);
      clearModuleRegistry();
      install('alpha');
    }
  });

  it('a module-vs-module conflict is a registration error, not a race', () => {
    install('alpha');
    install('beta');
    validateRuntime(runtime('alpha', { shortcuts: [{ key: 'r', run: () => {} }] }));
    // Only one module is active at a time, so the claim is kept for the session: releasing it
    // on deactivate would let both modules own `r` and the collision would never be detected.
    expect(() =>
      validateRuntime(runtime('beta', { shortcuts: [{ key: 'r', run: () => {} }] }))
    ).toThrow(/Duplicate shortcut binding/);
  });

  it('allows a shortcut core does not bind', () => {
    install('alpha');
    expect(() =>
      validateRuntime(runtime('alpha', { shortcuts: [{ key: 'r', run: () => {} }] }))
    ).not.toThrow();
  });

  it('CORE_RESERVED_SHORTCUTS covers every binding the shell actually registers', () => {
    const noop = () => {};
    const bindings = createDefaultKeyboardShortcuts({
      setViewMode: noop,
      toggleUnitFormat: noop,
      toggleMeasurement: noop,
      undo: noop,
      redo: noop,
      handleEscape: noop,
      handleDelete: noop,
    });
    for (const binding of bindings) {
      expect(CORE_RESERVED_SHORTCUTS).toContain(shortcutBindingKey(binding));
    }
  });
});
