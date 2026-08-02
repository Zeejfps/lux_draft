import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as THREE from 'three';
import type { EditorDocument } from '../../../src/floorplan/types/document';
import { applyCommand } from '../../../src/floorplan/commands';
import { valueEqual } from '../../../src/floorplan/commands/serializable';
import {
  CORE_RESERVED_SHORTCUTS,
  shortcutBindingKey,
} from '../../../src/floorplan/types/moduleRuntime';
import { claimLayerIds, validateRuntime } from '../../../src/floorplan/types/moduleRegistry';
import { NO_ENTITIES } from '../../../src/floorplan/types/entity';
import { lightingRuntime } from '../../../src/modules/lighting/runtime';
import { LIGHTING_MODULE_ID } from '../../../src/modules/lighting/codec';
import { fixtureSelection } from '../../../src/modules/lighting/selection';
import {
  activateModule,
  activeModule,
  deactivateModule,
  setModuleScene,
} from '../../../src/floorplan/stores/moduleActivation';
import { resolvePanel } from '../../../src/floorplan/ui/panelRegistry';
import { sessionStore } from '../../../src/floorplan/stores/sessionStore';
import { asLoadedDocument } from '../../../src/floorplan/types/session';
import { get } from 'svelte/store';
import { makeLight, squareRoom } from '../../helpers/documents';
import { fixtureEntityAccess } from '../../helpers/entities';

/**
 * Lighting against the module contract.
 *
 * Phase 4 validates the contract on the module that already works, before flooring exists to
 * confuse a contract failure with a new-code failure. If something here is awkward, the
 * contract is wrong — not lighting.
 */

let doc: EditorDocument;

beforeEach(() => {
  doc = squareRoom({
    lights: [makeLight('l1', { x: 2, y: 2 }), makeLight('l2', { x: 6, y: 6 })],
  });
});

describe('the lighting runtime satisfies registration', () => {
  it('validates against the installed module table', () => {
    expect(() => validateRuntime(lightingRuntime)).not.toThrow();
    expect(lightingRuntime.id).toBe(LIGHTING_MODULE_ID);
  });

  it('namespaces every tool with its module id', () => {
    for (const tool of lightingRuntime.tools ?? []) {
      expect(tool.id.startsWith(`${LIGHTING_MODULE_ID}.`)).toBe(true);
    }
  });

  it('keys its panels by SelectionKind.panelKey', () => {
    expect(Object.keys(lightingRuntime.panels ?? {})).toEqual([fixtureSelection.panelKey]);
  });

  it('binds no shortcut the core shell owns', () => {
    for (const shortcut of lightingRuntime.shortcuts ?? []) {
      expect(CORE_RESERVED_SHORTCUTS).not.toContain(shortcutBindingKey(shortcut));
    }
  });

  it('builds layers with unique, namespaced ids', () => {
    const scene = new THREE.Scene();
    const layers = lightingRuntime.layers!(scene);
    const ids = layers.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith(`${LIGHTING_MODULE_ID}.`)).toBe(true);
    expect(() => claimLayerIds(LIGHTING_MODULE_ID, ids)).not.toThrow();
    for (const layer of layers) layer.dispose();
  });
});

describe('fixtures as module entities', () => {
  const entities = () => fixtureEntityAccess(() => doc);

  it('lists, finds, hit-tests and box-selects without core naming a fixture', () => {
    const access = entities();
    expect(access.list().map((e) => e.id)).toEqual(['l1', 'l2']);
    expect(access.find('l2')?.position).toEqual({ x: 6, y: 6 });
    expect(access.at({ x: 2.1, y: 2 })?.id).toBe('l1');
    expect(access.at({ x: 4, y: 4 })).toBeNull();
    expect(access.inBox({ x: 0, y: 0 }, { x: 3, y: 3 })).toEqual(['l1']);
  });

  it('round-trips its selection through the core union', () => {
    const access = entities();
    const selection = access.selectionOf(['l1', 'l2']);
    expect(access.selectedIds(selection)).toEqual(['l1', 'l2']);
    expect(access.selectionOf([]).kind).toBe('none');
  });

  it('produces an absolute move command: applying twice equals applying once', () => {
    const access = entities();
    const command = access.moveCommand('l1', { x: 4, y: 5 });
    const once = applyCommand(doc, command);
    const twice = applyCommand(once, command);
    expect(valueEqual(once, twice)).toBe(true);
  });

  it('deletes a whole selection as one command', () => {
    const access = entities();
    const command = access.removeCommand(['l1', 'l2'])!;
    const next = applyCommand(doc, command);
    expect(next.modules).toBeDefined();
    expect(access.removeCommand([])).toBeNull();
    // One command, so one history entry, whatever the cardinality.
    expect(Array.isArray((command as { commands?: unknown[] }).commands)).toBe(true);
    doc = next;
    expect(entities().list()).toHaveLength(0);
  });
});

describe('no active module', () => {
  it('NO_ENTITIES is total, so core never branches on "is a module active"', () => {
    expect(NO_ENTITIES.list()).toEqual([]);
    expect(NO_ENTITIES.at({ x: 0, y: 0 })).toBeNull();
    expect(NO_ENTITIES.inBox({ x: -9, y: -9 }, { x: 9, y: 9 })).toEqual([]);
    expect(NO_ENTITIES.selectedIds(fixtureSelection.make({ ids: ['l1'] }))).toEqual([]);
    expect(NO_ENTITIES.selectionOf(['l1']).kind).toBe('none');
    expect(NO_ENTITIES.removeCommand(['l1'])).toBeNull();
  });
});

describe('lighting activated through the registry', () => {
  let scene: THREE.Scene;

  beforeEach(() => {
    scene = new THREE.Scene();
    setModuleScene(scene);
    sessionStore.open(asLoadedDocument(doc));
  });

  afterEach(() => {
    deactivateModule();
    setModuleScene(null);
  });

  it('contributes layers, handlers, tools, a panel and entities, and gives them all back', async () => {
    await activateModule(LIGHTING_MODULE_ID);

    const record = get(activeModule)!;
    expect(record.id).toBe(LIGHTING_MODULE_ID);
    expect(record.layers.length).toBeGreaterThan(0);
    expect(record.handlers).toHaveLength(1);
    expect(record.tools.map((t) => t.id)).toEqual(['lighting.place']);
    expect(record.statsPanel).not.toBeNull();
    expect(resolvePanel(fixtureSelection.panelKey)).not.toBeNull();
    expect(record.entities.list().map((e) => e.id)).toEqual(['l1', 'l2']);

    const drawn = scene.children.length;
    expect(drawn).toBeGreaterThan(0);

    deactivateModule();
    expect(get(activeModule)).toBeNull();
    expect(scene.children).toHaveLength(0);
    // The panel came from the runtime, so it goes with the scope.
    expect(resolvePanel(fixtureSelection.panelKey)).toBeNull();
    expect(sessionStore.current().diagnostics.runtimeStatus.lighting).toEqual({ kind: 'inactive' });
  });

  it('writes only through a registered command', async () => {
    await activateModule(LIGHTING_MODULE_ID);
    const before = sessionStore.current().document;

    const record = get(activeModule)!;
    sessionStore.dispatch(record.entities.moveCommand('l1', { x: 9, y: 9 }));

    const after = sessionStore.current().document;
    expect(after).not.toBe(before);
    expect(record.entities.find('l1')?.position).toEqual({ x: 9, y: 9 });
    // One command, one history entry.
    expect(sessionStore.current().history.past).toHaveLength(1);
  });
});
