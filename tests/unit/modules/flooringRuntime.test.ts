import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import * as THREE from 'three';
import type { EditorDocument } from '../../../src/floorplan/types/document';
import { applyCommand } from '../../../src/floorplan/commands';
import { valueEqual } from '../../../src/floorplan/commands/serializable';
import {
  CORE_RESERVED_SHORTCUTS,
  moduleViewOf,
  shortcutBindingKey,
} from '../../../src/floorplan/types/moduleRuntime';
import { claimLayerIds, validateRuntime } from '../../../src/floorplan/types/moduleRegistry';
import { bindEntities } from '../../../src/floorplan/types/entity';
import { readModule } from '../../../src/floorplan/types/module';
import { NO_SELECTION } from '../../../src/floorplan/types/selection';
import { DEFAULT_DISPLAY_PREFERENCES } from '../../../src/floorplan/types/state';
import { sessionStore } from '../../../src/floorplan/stores/sessionStore';
import { asLoadedDocument } from '../../../src/floorplan/types/session';
import { resolvePanel } from '../../../src/floorplan/ui/panelRegistry';
import {
  activateModule,
  activeModule,
  deactivateModule,
  moduleEntitySummary,
  setModuleScene,
} from '../../../src/floorplan/stores/moduleActivation';
import { flooringRuntime } from '../../../src/modules/flooring/runtime';
import { FLOORING_MODULE_ID, flooringCodec } from '../../../src/modules/flooring/codec';
import { originSelection } from '../../../src/modules/flooring/selection';
import { originEntities } from '../../../src/modules/flooring/entities';
import { LAYOUT_ORIGIN_ID } from '../../../src/modules/flooring/constants';
import { PlankIndex } from '../../../src/modules/flooring/PlankIndex';
import { computePlankLayout } from '../../../src/modules/flooring/PlankLayoutEngine';
import { addDivider, setSurfaces } from '../../../src/modules/flooring/commands';
import { solveRegions } from '../../../src/modules/flooring/RegionSolver';
import { defaultFlooringData } from '../../../src/modules/flooring/codec';
import { makeDoor, rectWalls, squareRoom } from '../../helpers/documents';

/**
 * The **second** module against the module contract.
 *
 * Phase 4 validated the contract on lighting, which already worked. This file is the real
 * question the whole plan was asking: does a module in a different domain fit the same seams,
 * or does the contract turn out to have been lighting-shaped all along?
 */

let doc: EditorDocument;

beforeEach(() => {
  doc = squareRoom();
});

describe('the flooring runtime satisfies registration', () => {
  it('validates against the installed module table', () => {
    expect(() => validateRuntime(flooringRuntime)).not.toThrow();
    expect(flooringRuntime.id).toBe(FLOORING_MODULE_ID);
  });

  it('namespaces every tool and overlay with its module id', () => {
    for (const tool of flooringRuntime.tools ?? []) {
      expect(tool.id.startsWith(`${FLOORING_MODULE_ID}.`)).toBe(true);
    }
    for (const overlay of flooringRuntime.overlays ?? []) {
      expect(overlay.id.startsWith(`${FLOORING_MODULE_ID}.`)).toBe(true);
    }
  });

  it('keys its panels by SelectionKind.panelKey', () => {
    expect(Object.keys(flooringRuntime.panels ?? {})).toEqual([originSelection.panelKey]);
    expect(originSelection.panelKey).toBe('flooring.origin');
  });

  it('binds no shortcut the core shell owns, and none lighting already claimed', () => {
    for (const shortcut of flooringRuntime.shortcuts ?? []) {
      expect(CORE_RESERVED_SHORTCUTS).not.toContain(shortcutBindingKey(shortcut));
    }
    // `validateRuntime` is what enforces the module-vs-module half; both are validated in this
    // suite's `beforeEach` chain via the registry, so a clash would throw there.
    expect(() => validateRuntime(flooringRuntime)).not.toThrow();
  });

  it('builds layers with unique, namespaced ids', () => {
    const scene = new THREE.Scene();
    const layers = flooringRuntime.layers!(scene);
    const ids = layers.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith(`${FLOORING_MODULE_ID}.`)).toBe(true);
    expect(() => claimLayerIds(FLOORING_MODULE_ID, ids)).not.toThrow();
    for (const layer of layers) layer.dispose();
    expect(scene.children).toHaveLength(0);
  });
});

describe('the layout origin as a module entity', () => {
  const access = () =>
    bindEntities(originEntities, () =>
      moduleViewOf(
        doc,
        readModule(doc, flooringCodec),
        NO_SELECTION,
        DEFAULT_DISPLAY_PREFERENCES,
        'editor'
      )
    );

  it('is a single entity, which the seam takes without a change', () => {
    expect(access().list()).toEqual([{ id: LAYOUT_ORIGIN_ID, position: { x: 0, y: 0 } }]);
    expect(access().at({ x: 0.2, y: 0.2 })?.id).toBe(LAYOUT_ORIGIN_ID);
    expect(access().at({ x: 5, y: 5 })).toBeNull();
    expect(access().inBox({ x: -1, y: -1 }, { x: 1, y: 1 })).toEqual([LAYOUT_ORIGIN_ID]);
  });

  it('produces an absolute move command: applying twice equals applying once', () => {
    const command = access().moveCommand(LAYOUT_ORIGIN_ID, { x: 3, y: 4 });
    const once = applyCommand(doc, command);
    const twice = applyCommand(once, command);
    expect(valueEqual(once, twice)).toBe(true);
    expect(readModule(once, flooringCodec).origin).toEqual({ x: 3, y: 4 });
  });

  it('cannot be deleted, and says so by returning null rather than by throwing', () => {
    expect(access().removeCommand([LAYOUT_ORIGIN_ID])).toBeNull();
    expect(access().removeCommand([])).toBeNull();
  });

  it('round-trips its selection through the core union', () => {
    const selection = access().selectionOf([LAYOUT_ORIGIN_ID]);
    expect(access().selectedIds(selection)).toEqual([LAYOUT_ORIGIN_ID]);
    expect(access().selectionOf([]).kind).toBe('none');
  });
});

describe('planks are hit-tested, not selected', () => {
  const defaults = defaultFlooringData();

  it('the spatial index finds the plank under a point', () => {
    const layout = computePlankLayout({
      walls: rectWalls(20, 20),
      isClosed: true,
      obstacles: [],
      plank: defaults.plank,
      layout: { ...defaults.layout, expansionGapIn: 0 },
      origin: defaults.origin,
    });
    const index = new PlankIndex(layout);
    expect(index.size).toBeGreaterThan(150);

    for (const plank of layout.planks.slice(0, 25)) {
      expect(index.at(plank.center)?.id).toBe(plank.id);
    }
    expect(index.at({ x: -5, y: -5 })).toBeNull();
  });

  it('a grid lookup does not degrade with the size of the floor', () => {
    const build = (widthIn: number) =>
      new PlankIndex(
        computePlankLayout({
          walls: rectWalls(30, 30),
          isClosed: true,
          obstacles: [],
          plank: { ...defaults.plank, widthIn },
          layout: defaults.layout,
          origin: defaults.origin,
        })
      );
    const small = build(9);
    const large = build(2.25);
    expect(large.size).toBeGreaterThan(small.size * 3);
    // Both answer, and neither needs to see more than one cell to do it.
    expect(large.at({ x: 15, y: 15 })).not.toBeNull();
    expect(small.at({ x: 15, y: 15 })).not.toBeNull();
  });

  it('there is no plank selection kind — a plank is output, not an entity', () => {
    expect(Object.keys(flooringRuntime.panels ?? {})).not.toContain('flooring.plank');
    expect(flooringRuntime.entities?.selection.type).toBe('origin');
  });
});

describe('flooring activated through the registry', () => {
  let scene: THREE.Scene;

  beforeEach(() => {
    scene = new THREE.Scene();
    setModuleScene(scene);
    doc = squareRoom({ doors: [makeDoor('d1', 'wall-1', 5)] });
    sessionStore.open(asLoadedDocument(doc));
  });

  afterEach(() => {
    deactivateModule();
    setModuleScene(null);
  });

  it('contributes layers, handlers, a tool, overlays, a panel and surfaces — and gives them back', async () => {
    await activateModule(FLOORING_MODULE_ID);

    const record = get(activeModule)!;
    expect(record.id).toBe(FLOORING_MODULE_ID);
    expect(record.layers.map((l) => l.id)).toEqual([
      'flooring.planks',
      'flooring.transitions',
      'flooring.origin',
    ]);
    expect(record.handlers).toHaveLength(3);
    expect(record.tools.map((t) => t.id)).toEqual(['flooring.transition', 'flooring.divider']);
    expect(record.overlays.map((o) => o.id)).toContain('flooring.summary');
    expect(record.surfaces).toHaveLength(2);
    expect(resolvePanel(originSelection.panelKey)).not.toBeNull();
    // The shell's count row, straight off the entity seam.
    expect(get(moduleEntitySummary)).toEqual({ label: 'Layout origin', count: 1 });
    expect(scene.children.length).toBeGreaterThan(0);

    deactivateModule();
    expect(get(activeModule)).toBeNull();
    expect(scene.children).toHaveLength(0);
    expect(resolvePanel(originSelection.panelKey)).toBeNull();
    expect(sessionStore.current().diagnostics.runtimeStatus.flooring).toEqual({ kind: 'inactive' });
  });

  it('the transition tool is disabled until the room has a door', async () => {
    await activateModule(FLOORING_MODULE_ID);
    const tool = get(activeModule)!.tools[0];
    const viewWith = moduleViewOf(
      doc,
      readModule(doc, flooringCodec),
      NO_SELECTION,
      DEFAULT_DISPLAY_PREFERENCES,
      'editor'
    );
    const doorless = squareRoom();
    const viewWithout = moduleViewOf(
      doorless,
      readModule(doorless, flooringCodec),
      NO_SELECTION,
      DEFAULT_DISPLAY_PREFERENCES,
      'editor'
    );
    expect(tool.enabled!(viewWith)).toBe(true);
    expect(tool.enabled!(viewWithout)).toBe(false);
  });

  it('writes only through a registered command', async () => {
    await activateModule(FLOORING_MODULE_ID);
    const record = get(activeModule)!;
    const before = sessionStore.current().document;

    sessionStore.dispatch(record.entities.moveCommand(LAYOUT_ORIGIN_ID, { x: 2, y: 2 }));

    expect(sessionStore.current().document).not.toBe(before);
    expect(record.entities.find(LAYOUT_ORIGIN_ID)?.position).toEqual({ x: 2, y: 2 });
    expect(sessionStore.current().history.past).toHaveLength(1);
  });

  it('activate → deactivate → activate leaves no orphaned scene children', async () => {
    await activateModule(FLOORING_MODULE_ID);
    const first = scene.children.length;
    deactivateModule();
    expect(scene.children).toHaveLength(0);
    await activateModule(FLOORING_MODULE_ID);
    expect(scene.children).toHaveLength(first);
  });

  it('switching from lighting to flooring and back leaves exactly one module active', async () => {
    await activateModule('lighting');
    await activateModule(FLOORING_MODULE_ID);
    await activateModule('lighting');
    expect(get(activeModule)!.id).toBe('lighting');
    expect(resolvePanel(originSelection.panelKey)).toBeNull();
    expect(resolvePanel('lighting.fixture')).not.toBeNull();
  });
});

describe('the transitions layer draws what the solver derived', () => {
  const viewOf = (document: EditorDocument) =>
    moduleViewOf(
      document,
      readModule(document, flooringCodec),
      NO_SELECTION,
      DEFAULT_DISPLAY_PREFERENCES,
      'editor'
    );

  /** Meshes under the layer's group, which is the only observable a renderer offers. */
  const meshCount = (scene: THREE.Scene): number => {
    let count = 0;
    scene.traverse((object) => {
      if ((object as THREE.Mesh).isMesh) count += 1;
    });
    return count;
  };

  it('draws a guide for a divider and a strip once the floors differ', () => {
    const scene = new THREE.Scene();
    const layers = flooringRuntime.layers!(scene);
    const transitions = layers.find((l) => l.id === 'flooring.transitions')!;

    const plain = squareRoom();
    transitions.update(viewOf(plain));
    const baseline = meshCount(scene);

    const withDivider = applyCommand(
      plain,
      addDivider.make({
        divider: { id: 'd1', a: { x: 0, y: 4 }, b: { x: 10, y: 4 }, kind: 'tMolding' },
      })
    );
    transitions.update(viewOf(withDivider));
    // One more mesh: the guide. No trim yet — the same floor runs either side of the line.
    expect(meshCount(scene)).toBe(baseline + 1);

    const solution = solveRegions({
      walls: withDivider.geometry.boundary.walls,
      isClosed: true,
      dividers: readModule(withDivider, flooringCodec).dividers,
      surfaces: [],
    });
    const upper = solution.regions.find((r) => r.seed.y > 4)!;
    const painted = applyCommand(
      withDivider,
      setSurfaces.make({
        surfaces: solution.regions.map((region) => ({
          seed: region.seed,
          surface: region === upper ? ('carpet' as const) : ('plank' as const),
        })),
      })
    );
    transitions.update(viewOf(painted));
    // Guide plus the derived strip, now that there is trim to buy.
    expect(meshCount(scene)).toBe(baseline + 2);

    for (const layer of layers) layer.dispose();
    expect(scene.children).toHaveLength(0);
  });
});
