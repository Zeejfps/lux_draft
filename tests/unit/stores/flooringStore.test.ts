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
  committedFlooringData,
  flooringData,
  layoutConfig,
  plankSpec,
  removeDoorTransition,
  requestLayout,
  setOrigin,
  setPlank,
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
    ['plank', () => setPlank({ widthIn: 5, lengthIn: 36, name: 'Narrow' })],
    ['origin', () => setOrigin({ x: 1, y: 2 })],
    ['transition', () => addDoorTransition('d1')],
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
    setPlank({ widthIn: 5, lengthIn: 36, name: 'Narrow' });
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
    setPlank({ widthIn: 9, lengthIn: 60, name: 'Wide' });
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
      'layout',
      'origin',
      'plank',
      'transitions',
    ]);
  });
});
