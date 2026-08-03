import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';
import { sessionStore } from '../../../src/floorplan/stores/sessionStore';
import { asLoadedDocument } from '../../../src/floorplan/types/session';
import { readModule } from '../../../src/floorplan/types/module';
import { canUndo } from '../../../src/floorplan/types/session';
import { applyCommand } from '../../../src/floorplan/commands';
import { flooringCodec, liveTransitions } from '../../../src/modules/flooring/codec';
import { addTransition } from '../../../src/modules/flooring/commands';
import {
  addDoorTransition,
  addFloorDivider,
  committedFlooringData,
  currentRegions,
  flooringData,
  floorRegions,
  layoutConfig,
  plankSpec,
  removeDoorTransition,
  removeFloorDivider,
  requestLayout,
  setFloorDividerKind,
  setOrigin,
  setPlank,
  setRegionSurface,
  startLayoutService,
  updateLayoutConfig,
} from '../../../src/modules/flooring/store';
import { layoutInputsOf } from '../../../src/modules/flooring/layoutProjection';
import { moduleViewOf } from '../../../src/floorplan/types/moduleRuntime';
import { NO_SELECTION } from '../../../src/floorplan/types/selection';
import { DEFAULT_DISPLAY_PREFERENCES } from '../../../src/floorplan/types/state';
import { makeDoor, squareRoom } from '../../helpers/documents';

/**
 * Flooring's read and write layer: every write is one registered command and one history entry,
 * every read is a guarded projection of the session, and the derived floor is nowhere in either.
 */

const slice = () => readModule(sessionStore.current().document, flooringCodec);

beforeEach(() => {
  sessionStore.open(asLoadedDocument(squareRoom({ doors: [makeDoor('d1', 'wall-1', 5)] })));
});

describe('every setter is one command and one history entry', () => {
  const cases: [string, () => void][] = [
    ['layout', () => updateLayoutConfig({ stagger: 'half' })],
    ['plank', () => setPlank({ widthIn: 5, lengthIn: 36, name: 'Narrow', minRipWidthIn: 1.75 })],
    ['origin', () => setOrigin({ x: 1, y: 2 })],
    ['transition', () => addDoorTransition('d1')],
    ['divider', () => addFloorDivider({ x: 0, y: 4 }, { x: 10, y: 4 })],
  ];

  for (const [name, run] of cases) {
    it(`${name} produces exactly one undoable entry`, () => {
      run();
      expect(sessionStore.current().history.past).toHaveLength(1);
      expect(canUndo(sessionStore.current().history)).toBe(true);
      sessionStore.undo();
      expect(slice()).toEqual(flooringCodec.defaultData());
    });
  }

  it('labels the entry for what the user did, not for what changed', () => {
    updateLayoutConfig({ stagger: 'half' });
    expect(sessionStore.current().history.past.at(-1)?.label).toBe('Change floor layout');
    setPlank({ widthIn: 5, lengthIn: 36, name: 'Narrow', minRipWidthIn: 1.75 });
    expect(sessionStore.current().history.past.at(-1)?.label).toBe('Change plank size');
  });

  it('a partial layout change keeps every other field', () => {
    const before = slice().layout;
    updateLayoutConfig({ minEndCutIn: 12 });
    expect(slice().layout).toEqual({ ...before, minEndCutIn: 12 });
  });

  it('normalizes the run angle on the way in, so 190 and 10 are the same floor', () => {
    updateLayoutConfig({ runAngleDeg: 190 });
    expect(slice().layout.runAngleDeg).toBeCloseTo(10, 9);
  });
});

describe('reads', () => {
  it('the committed projections track the document', () => {
    expect(get(plankSpec).widthIn).toBe(7);
    setPlank({ widthIn: 9, lengthIn: 60, name: 'Wide', minRipWidthIn: 3 });
    expect(get(plankSpec).widthIn).toBe(9);
    expect(get(layoutConfig)).toEqual(slice().layout);
    expect(get(committedFlooringData)).toEqual(slice());
  });

  it('the live projection is what a layer reads, so a drag previews', () => {
    expect(get(flooringData).origin).toEqual({ x: 0, y: 0 });
    sessionStore.setInteraction({
      kind: 'commandPreview',
      command: {
        type: 'flooring.origin.move',
        moduleId: 'flooring',
        payload: { position: { x: 4, y: 4 } },
      },
    });
    expect(get(flooringData).origin).toEqual({ x: 4, y: 4 });
    // ...and the committed view does not, so a panel does not flicker mid-gesture.
    expect(get(committedFlooringData).origin).toEqual({ x: 0, y: 0 });
    sessionStore.cancelInteraction();
  });
});

describe('doors are thresholds', () => {
  it('a transition names a door and carries no geometry of its own', () => {
    addDoorTransition('d1');
    const transition = slice().transitions[0];
    expect(Object.keys(transition).sort()).toEqual(['doorId', 'id', 'kind']);
    expect(transition.doorId).toBe('d1');
  });

  it('moving the door moves the threshold, with no flooring command involved', () => {
    addDoorTransition('d1');
    const before = slice();
    sessionStore.dispatch({ type: 'door.move', doorId: 'd1', offset: 7 });
    // The flooring slice is untouched: the transition resolves through the door every time.
    expect(slice()).toBe(before);
    expect(sessionStore.current().document.geometry.doors[0].position).toBe(7);
  });

  it('deleting the door leaves the transition inert rather than dangling', () => {
    addDoorTransition('d1');
    sessionStore.dispatch({ type: 'door.remove', doorId: 'd1' });
    const document = sessionStore.current().document;
    // Still stored — a core command may not rewrite a module's slice — but not live.
    expect(slice().transitions).toHaveLength(1);
    expect(liveTransitions(slice().transitions, document.geometry.doors)).toHaveLength(0);
  });

  it('re-trimming a doorway replaces rather than stacks', () => {
    addDoorTransition('d1');
    addDoorTransition('d1');
    expect(slice().transitions).toHaveLength(1);
  });

  it('removes by id', () => {
    addDoorTransition('d1');
    removeDoorTransition(slice().transitions[0].id);
    expect(slice().transitions).toHaveLength(0);
  });

  it('an unknown transition id is a no-op, not a throw', () => {
    const before = sessionStore.current().document;
    removeDoorTransition('nope');
    expect(sessionStore.current().document).toBe(before);
  });

  it('a transition survives a document round-trip through its own codec', () => {
    const document = applyCommand(
      sessionStore.current().document,
      addTransition.make({ transition: { id: 't1', doorId: 'd1', kind: 'reducer' } })
    );
    const data = readModule(document, flooringCodec);
    const decoded = flooringCodec.decode({ v: flooringCodec.schemaVersion, data });
    expect(decoded.status).toBe('ok');
    if (decoded.status === 'ok') expect(decoded.data.transitions).toEqual(data.transitions);
  });
});

describe('dividers and surfaces', () => {
  it('a divider splits the room into two areas', () => {
    expect(currentRegions().regions).toHaveLength(1);
    addFloorDivider({ x: 0, y: 4 }, { x: 10, y: 4 });
    const solution = currentRegions();
    expect(solution.regions).toHaveLength(2);
    expect(solution.unattached).toHaveLength(0);
    // Two areas, one floor: a line is not a transition until the floors either side differ.
    expect(solution.transitions).toHaveLength(0);
  });

  it('assigning a surface names every area, so nothing is left to a stale seed', () => {
    addFloorDivider({ x: 0, y: 4 }, { x: 10, y: 4 });
    const upper = currentRegions().regions.find((r) => r.seed.y > 4)!;
    setRegionSurface(upper.seed, 'carpet');

    // One entry per area, not one for the one that changed.
    expect(slice().surfaces).toHaveLength(2);
    const solution = currentRegions();
    expect(solution.regions.find((r) => r.seed.y > 4)!.surface).toBe('carpet');
    expect(solution.regions.find((r) => r.seed.y < 4)!.surface).toBe('plank');
    expect(solution.transitions).toHaveLength(1);
  });

  it('a point in no area writes nothing at all', () => {
    const before = sessionStore.current().document;
    setRegionSurface({ x: 500, y: 500 }, 'carpet');
    expect(sessionStore.current().document).toBe(before);
  });

  it('removing the divider puts the room back to one area', () => {
    addFloorDivider({ x: 0, y: 4 }, { x: 10, y: 4 });
    const [divider] = slice().dividers;
    setRegionSurface(currentRegions().regions.find((r) => r.seed.y > 4)!.seed, 'carpet');
    removeFloorDivider(divider.id);

    const solution = currentRegions();
    expect(solution.regions).toHaveLength(1);
    expect(solution.transitions).toHaveLength(0);
    // The assignments outlive the divider in the document; they are simply not addressable,
    // which is what stops a delete from needing to rewrite unrelated data.
    expect(slice().surfaces).toHaveLength(2);
  });

  it('changing the trim type does not move the line', () => {
    addFloorDivider({ x: 0, y: 4 }, { x: 10, y: 4 });
    const [divider] = slice().dividers;
    setFloorDividerKind(divider.id, 'reducer');
    const [updated] = slice().dividers;
    expect(updated.kind).toBe('reducer');
    expect(updated.a).toEqual(divider.a);
    expect(updated.b).toEqual(divider.b);
  });

  it('the areas store emits when the split changes and not otherwise', () => {
    const seen: number[] = [];
    const stop = floorRegions.subscribe((solution) => seen.push(solution.regions.length));
    addFloorDivider({ x: 0, y: 4 }, { x: 10, y: 4 });
    setOrigin({ x: 1, y: 1 });
    stop();
    // One for the initial value, one for the split. Moving the origin changes no area.
    expect(seen).toEqual([1, 2]);
  });

  it('dividers and surfaces survive a round-trip through the codec', () => {
    addFloorDivider({ x: 0, y: 4 }, { x: 10, y: 4 });
    setRegionSurface(currentRegions().regions.find((r) => r.seed.y > 4)!.seed, 'carpet');
    const data = slice();
    const decoded = flooringCodec.decode({ v: flooringCodec.schemaVersion, data });
    expect(decoded.status).toBe('ok');
    if (decoded.status === 'ok') {
      expect(decoded.data.dividers).toEqual(data.dividers);
      expect(decoded.data.surfaces).toEqual(data.surfaces);
    }
  });

  it('reads a v1 slice, which had neither field, as the room it always was', () => {
    const decoded = flooringCodec.decode({
      v: 1,
      data: { plank: { widthIn: 7, lengthIn: 48, name: '7in' }, origin: { x: 0, y: 0 } },
    });
    expect(decoded.status).toBe('ok');
    if (decoded.status === 'ok') {
      expect(decoded.data.dividers).toEqual([]);
      expect(decoded.data.surfaces).toEqual([]);
    }
  });

  it('quarantines a malformed divider rather than dropping it silently', () => {
    for (const dividers of [
      [{ id: 'd', a: { x: 0, y: 0 }, b: { x: 1, y: 1 }, kind: 'wat' }],
      [{ id: 'd', a: { x: 0, y: 0 }, kind: 'reducer' }],
      [{ id: 'd', a: { x: 0, y: 0 }, b: { x: 0, y: 0 }, kind: 'reducer' }],
      [
        { id: 'same', a: { x: 0, y: 0 }, b: { x: 1, y: 1 }, kind: 'reducer' },
        { id: 'same', a: { x: 0, y: 2 }, b: { x: 1, y: 3 }, kind: 'reducer' },
      ],
    ]) {
      expect(flooringCodec.decode({ v: 2, data: { dividers } }).status).toBe('invalid');
    }
  });

  it('quarantines a malformed surface assignment', () => {
    expect(
      flooringCodec.decode({
        v: 2,
        data: { surfaces: [{ seed: { x: 0, y: 0 }, surface: 'lava' }] },
      }).status
    ).toBe('invalid');
    expect(flooringCodec.decode({ v: 2, data: { surfaces: [{ surface: 'carpet' }] } }).status).toBe(
      'invalid'
    );
  });
});

describe('the layout service', () => {
  let controller: AbortController;
  let stop: () => void;

  beforeEach(() => {
    controller = new AbortController();
  });

  afterEach(() => {
    stop?.();
    controller.abort();
  });

  it('answers nothing before it starts, so a layer built early cannot crash', () => {
    const document = sessionStore.current().document;
    const view = moduleViewOf(
      document,
      readModule(document, flooringCodec),
      NO_SELECTION,
      DEFAULT_DISPLAY_PREFERENCES,
      'editor'
    );
    expect(requestLayout(layoutInputsOf(view))).toBeNull();
  });

  it('publishes a floor once the scheduled work runs, and nothing before', () => {
    let queued: (() => void) | null = null;
    stop = startLayoutService(controller.signal, (run) => {
      queued = run;
      return () => {
        queued = null;
      };
    });

    const document = sessionStore.current().document;
    const view = moduleViewOf(
      document,
      readModule(document, flooringCodec),
      NO_SELECTION,
      DEFAULT_DISPLAY_PREFERENCES,
      'editor'
    );

    expect(requestLayout(layoutInputsOf(view))).toBeNull();
    expect(queued).not.toBeNull();
    queued!();
    const layout = requestLayout(layoutInputsOf(view));
    expect(layout!.planks.length).toBeGreaterThan(0);
    // 10 x 10 room: a real cut list, derived and never stored.
    expect(layout!.cutList.length).toBeGreaterThan(0);
    expect(layout!.purchasedPlanks).toBeGreaterThan(0);
  });

  it('the derived floor has no field on the persisted slice', () => {
    expect(Object.keys(flooringCodec.defaultData()).sort()).toEqual([
      'dividers',
      'layout',
      'origin',
      'plank',
      'surfaces',
      'transitions',
    ]);
  });
});
