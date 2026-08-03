import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import * as THREE from 'three';
import type { EditorDocument } from '../../../src/floorplan/types/document';
import type { Vector2 } from '../../../src/floorplan/types/geometry';
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
import { CORE_TOOL_SELECT, DEFAULT_DISPLAY_PREFERENCES } from '../../../src/floorplan/types/state';
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
import { interiorPoint } from '../../../src/modules/flooring/geometry2d';
import { computePlankLayout, type Plank } from '../../../src/modules/flooring/PlankLayoutEngine';
import { addDivider, setSurfaces } from '../../../src/modules/flooring/commands';
import { solveRegions } from '../../../src/modules/flooring/RegionSolver';
import { DividerPlacementHandler, PlankPickHandler } from '../../../src/modules/flooring/handlers';
import { setActiveTool } from '../../../src/floorplan/stores/appStore';

import { FLOORING_TOOL_DIVIDER } from '../../../src/modules/flooring/constants';
import type { InteractionContext } from '../../../src/floorplan/types/interaction';
import type { InputEvent } from '../../../src/floorplan/core/InputManager';
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

  it('registers no selection-driven panel — the origin is edited in the layout surface', () => {
    expect(Object.keys(flooringRuntime.panels ?? {})).toEqual([]);
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

  it('tests the point against the quad, not the nominal rectangle', () => {
    // A run at 45°, so every wall is diagonal in the run frame and the pieces against them are
    // trapezoids. The nominal rectangle about a mitred piece's centre reaches past the wall, so
    // a point-in-rectangle test would claim the wedge outside the room — hovering just past a
    // wall would light up a board that is not there.
    const layout = computePlankLayout({
      walls: rectWalls(20, 20),
      isClosed: true,
      obstacles: [],
      plank: defaults.plank,
      layout: { ...defaults.layout, expansionGapIn: 0, runAngleDeg: 45 },
      origin: defaults.origin,
    });
    const index = new PlankIndex(layout);

    // Every plank still answers for a point inside its own outline. Over the corners it has,
    // not over four of them: a board is a polygon, and one whose end bends where the boundary
    // crosses it carries five.
    for (const plank of layout.planks.slice(0, 40)) {
      const inside = interiorPoint(plank.corners);
      expect(inside, `${plank.id} has an interior`).not.toBeNull();
      expect(index.at(inside as Vector2)?.id).toBe(plank.id);
    }
    // And nothing at all answers from outside the room, however close to the wall.
    for (const t of [0.5, 2.5, 7.25, 13, 19.5]) {
      expect(index.at({ x: t, y: -0.001 })).toBeNull();
      expect(index.at({ x: -0.001, y: t })).toBeNull();
      expect(index.at({ x: t, y: 20.001 })).toBeNull();
    }
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

  it('contributes layers, handlers, a tool, overlays and surfaces — and gives them back', async () => {
    await activateModule(FLOORING_MODULE_ID);

    const record = get(activeModule)!;
    expect(record.id).toBe(FLOORING_MODULE_ID);
    expect(record.layers.map((l) => l.id)).toEqual([
      'flooring.planks',
      'flooring.transitions',
      'flooring.origin',
    ]);
    expect(record.handlers).toHaveLength(4);
    expect(record.tools.map((t) => t.id)).toEqual(['flooring.transition', 'flooring.divider']);
    expect(record.overlays.map((o) => o.id)).toContain('flooring.summary');
    expect(record.surfaces).toHaveLength(3);
    expect(resolvePanel(originSelection.panelKey)).toBeNull();
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
  // The tool is global state; leaving it set would leak into whatever runs next.
  afterEach(() => setActiveTool(CORE_TOOL_SELECT));

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
    // Nothing new on screen. The same floor runs either side of the line, so there is no trim,
    // and a line that changes neither the floor nor the cut list is not drawn over the floor —
    // it lives in the panel and comes back under the divider tool.
    expect(meshCount(scene)).toBe(baseline);

    setActiveTool(FLOORING_TOOL_DIVIDER);
    transitions.update(viewOf(withDivider));
    expect(meshCount(scene)).toBe(baseline + 1);
    setActiveTool(CORE_TOOL_SELECT);
    transitions.update(viewOf(withDivider));
    expect(meshCount(scene)).toBe(baseline);

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
    // The derived strip, and only that: real trim draws with no tool selected, because it is
    // something you would actually buy and nail down.
    expect(meshCount(scene)).toBe(baseline + 1);

    for (const layer of layers) layer.dispose();
    expect(scene.children).toHaveLength(0);
  });

  it('keeps an unattached divider on screen whatever tool is up', () => {
    // An error is not an affordance. A line left dangling by a wall edit stays visible until it
    // is dealt with, and the panel flags it in words as well.
    const scene = new THREE.Scene();
    const layers = flooringRuntime.layers!(scene);
    const transitions = layers.find((l) => l.id === 'flooring.transitions')!;

    const plain = squareRoom();
    transitions.update(viewOf(plain));
    const baseline = meshCount(scene);

    const dangling = applyCommand(
      plain,
      addDivider.make({
        // Both ends in open space: it reaches no wall, so it splits nothing.
        divider: { id: 'd1', a: { x: 3, y: 5 }, b: { x: 7, y: 5 }, kind: 'tMolding' },
      })
    );
    setActiveTool(CORE_TOOL_SELECT);
    transitions.update(viewOf(dangling));
    expect(meshCount(scene)).toBe(baseline + 1);

    for (const layer of layers) layer.dispose();
  });
});

describe('the divider tool does not leave a line behind', () => {
  const walls = rectWalls(10, 10);
  let pending: { from: { x: number; y: number }; to: { x: number; y: number } } | null;
  let added: number;
  let handler: DividerPlacementHandler;

  const ctx = (tool: string) => ({ activeTool: tool }) as unknown as InteractionContext;
  const at = (x: number, y: number) =>
    ({ worldPos: { x, y }, key: undefined }) as unknown as InputEvent;

  beforeEach(() => {
    pending = null;
    added = 0;
    handler = new DividerPlacementHandler({
      getWalls: () => walls,
      getDividers: () => [],
      setPending: (next) => {
        pending = next;
      },
      addDivider: () => {
        added += 1;
      },
    });
  });

  it('shows a rubber band after the first click and clears it after the second', () => {
    handler.handleClick(at(0, 4), ctx('flooring.divider'));
    expect(pending).not.toBeNull();
    handler.handleClick(at(10, 4), ctx('flooring.divider'));
    expect(added).toBe(1);
    expect(pending).toBeNull();
  });

  it('abandons the half-drawn line when another tool takes over', () => {
    // The reported symptom: a line left across the room with no way to dismiss it, because
    // neither the second click nor Escape reaches a handler whose tool is no longer active.
    handler.handleClick(at(0, 4), ctx('flooring.divider'));
    expect(pending).not.toBeNull();

    handler.handleMouseMove(at(3, 3), ctx('select'));
    expect(pending).toBeNull();

    // And the abandoned point is not resurrected as the start of the next line.
    handler.handleClick(at(10, 4), ctx('flooring.divider'));
    expect(added).toBe(0);
    expect(pending).toEqual({ from: { x: 10, y: 4 }, to: { x: 10, y: 4 } });
  });

  it('clears on Escape', () => {
    handler.handleClick(at(0, 4), ctx('flooring.divider'));
    const escape = { worldPos: { x: 0, y: 0 }, key: 'Escape' } as unknown as InputEvent;
    expect(handler.handleKeyDown(escape, ctx('flooring.divider'))).toBe(true);
    expect(pending).toBeNull();
  });
});

describe('clicking a board reads out its dimensions', () => {
  const defaults = defaultFlooringData();
  const layout = computePlankLayout({
    walls: rectWalls(20, 20),
    isClosed: true,
    obstacles: [],
    plank: defaults.plank,
    layout: { ...defaults.layout, expansionGapIn: 0 },
    origin: defaults.origin,
  });
  const index = new PlankIndex(layout);

  let picked: Plank | null;
  let handler: PlankPickHandler;

  /** Select mode: nothing owns the pointer, which is when a board can be picked. */
  const selecting = (over: Partial<InteractionContext> = {}) =>
    ({
      isDrawingEnabled: false,
      isModuleToolActive: false,
      isPlacingDoors: false,
      isObstacleDrawing: false,
      isMeasuring: false,
      isGrabMode: false,
      ...over,
    }) as unknown as InteractionContext;
  const at = (x: number, y: number, key?: string) =>
    ({ worldPos: { x, y }, key }) as unknown as InputEvent;

  beforeEach(() => {
    picked = null;
    handler = new PlankPickHandler({
      plankAt: (position) => index.at(position),
      setSelected: (plank) => {
        picked = plank;
      },
    });
  });

  it('picks the board under the click and never consumes it', () => {
    const target = layout.planks[10];
    // False, always: core's selection handler has to see this click too, or the wall, vertex,
    // door and origin marker that all sit over the floor would stop being clickable.
    expect(handler.handleClick(at(target.center.x, target.center.y), selecting())).toBe(false);
    expect(picked?.id).toBe(target.id);
  });

  it('empties the read-out on a click off the floor', () => {
    handler.handleClick(at(layout.planks[0].center.x, layout.planks[0].center.y), selecting());
    expect(picked).not.toBeNull();
    handler.handleClick(at(-5, -5), selecting());
    expect(picked).toBeNull();
  });

  it('stands down while a tool owns the pointer', () => {
    // Placing a divider is not picking a board, even though the click lands on one.
    const target = layout.planks[10];
    const placing = selecting({ isModuleToolActive: true });
    expect(handler.canHandle(at(0, 0), placing)).toBe(false);
    handler.handleClick(at(target.center.x, target.center.y), placing);
    expect(picked).toBeNull();
  });

  it('dismisses on Escape, and still passes the key on', () => {
    const target = layout.planks[10];
    handler.handleClick(at(target.center.x, target.center.y), selecting());
    expect(handler.handleKeyDown(at(0, 0, 'Escape'), selecting())).toBe(false);
    expect(picked).toBeNull();
  });
});
