import { describe, it, expect, beforeEach } from 'vitest';
import type { ModuleView } from '../../../src/floorplan/types/moduleRuntime';
import { moduleViewOf } from '../../../src/floorplan/types/moduleRuntime';
import { DEFAULT_DISPLAY_PREFERENCES } from '../../../src/floorplan/types/state';
import { NO_SELECTION } from '../../../src/floorplan/types/selection';
import type { EditorDocument } from '../../../src/floorplan/types/document';
import type { FlooringData } from '../../../src/modules/flooring/codec';
import { defaultFlooringData, flooringCodec } from '../../../src/modules/flooring/codec';
import { readModule } from '../../../src/floorplan/types/module';
import type { LayoutInputs, PlankLayout } from '../../../src/modules/flooring/PlankLayoutEngine';
import { computePlankLayout, layoutKey } from '../../../src/modules/flooring/PlankLayoutEngine';
import {
  createProjection,
  createLayoutProjection,
  layoutInputsOf,
} from '../../../src/modules/flooring/layoutProjection';
import { originSelection } from '../../../src/modules/flooring/selection';
import { rectWalls, squareRoom } from '../../helpers/documents';

/**
 * The projection's five acceptance criteria, from "Derived data is a projection over narrow
 * inputs" in the plan. Each `describe` below is one of them.
 *
 * The plan's key risk for this phase is "plank layout blocks the frame on pointer moves". These
 * are the tests that say it does not.
 */

/** A scheduler under the test's control: nothing runs until `flush()`. */
function manualScheduler() {
  let pending: (() => void) | null = null;
  return {
    schedule: (run: () => void) => {
      pending = run;
      return () => {
        if (pending === run) pending = null;
      };
    },
    get queued(): boolean {
      return pending !== null;
    },
    flush(): void {
      const run = pending;
      pending = null;
      run?.();
    },
  };
}

const defaults = defaultFlooringData();

function inputsFor(width: number, over: Partial<LayoutInputs> = {}): LayoutInputs {
  return {
    walls: rectWalls(width, 20),
    isClosed: true,
    obstacles: [],
    plank: defaults.plank,
    layout: defaults.layout,
    origin: defaults.origin,
    ...over,
  };
}

function viewOf(document: EditorDocument, selection = NO_SELECTION): ModuleView<FlooringData> {
  return moduleViewOf(
    document,
    readModule(document, flooringCodec),
    selection,
    DEFAULT_DISPLAY_PREFERENCES,
    'editor'
  );
}

let controller: AbortController;

beforeEach(() => {
  controller = new AbortController();
});

describe('narrow inputs', () => {
  it('derives from geometry and the slice only — the view carries much more', () => {
    const document = squareRoom();
    const inputs = layoutInputsOf(viewOf(document));
    expect(Object.keys(inputs).sort()).toEqual([
      'isClosed',
      'layout',
      'obstacles',
      'origin',
      'plank',
      'regions',
      'walls',
    ]);
  });

  it('a selection change cannot invalidate a layout', () => {
    const document = squareRoom();
    const idle = layoutInputsOf(viewOf(document));
    const selected = layoutInputsOf(
      viewOf(document, originSelection.make({ ids: ['layout-origin'] }))
    );
    expect(layoutKey(selected)).toBe(layoutKey(idle));
  });

  it('and neither can the view mode or the display preferences', () => {
    const document = squareRoom();
    const base = layoutKey(layoutInputsOf(viewOf(document)));
    const other = moduleViewOf(
      document,
      readModule(document, flooringCodec),
      NO_SELECTION,
      {
        ...DEFAULT_DISPLAY_PREFERENCES,
        gridSnapEnabled: !DEFAULT_DISPLAY_PREFERENCES.gridSnapEnabled,
      },
      'heatmap'
    );
    expect(layoutKey(layoutInputsOf(other))).toBe(base);
  });
});

describe('keyed cache', () => {
  it('a repeat of a known key is a hit — no schedule, no computation', () => {
    const scheduler = manualScheduler();
    const projection = createLayoutProjection(controller.signal, scheduler.schedule);
    const inputs = inputsFor(20);

    expect(projection.get(inputs)).toBeNull();
    scheduler.flush();
    expect(projection.computations).toBe(1);

    const hit = projection.get(inputs);
    expect(hit).not.toBeNull();
    expect(scheduler.queued).toBe(false);
    expect(projection.computations).toBe(1);
  });

  it('undo/redo across a config change is a hit in both directions', () => {
    const scheduler = manualScheduler();
    const projection = createLayoutProjection(controller.signal, scheduler.schedule);
    const before = inputsFor(20);
    const after = inputsFor(20, { layout: { ...defaults.layout, stagger: 'half' } });

    projection.get(before);
    scheduler.flush();
    projection.get(after);
    scheduler.flush();
    expect(projection.computations).toBe(2);

    // Undo, then redo. Both are keys the cache already holds.
    expect(projection.get(before)!.key).toBe(layoutKey(before));
    expect(projection.get(after)!.key).toBe(layoutKey(after));
    expect(projection.computations).toBe(2);
    expect(scheduler.queued).toBe(false);
  });

  it('evicts the oldest key, and a hit is what keeps a key young', () => {
    const scheduler = manualScheduler();
    let computed = 0;
    const projection = createProjection<number, number>({
      key: (n) => String(n),
      compute: (n) => {
        computed += 1;
        return n * 2;
      },
      signal: controller.signal,
      schedule: scheduler.schedule,
      cacheSize: 2,
    });

    for (const n of [1, 2]) {
      projection.get(n);
      scheduler.flush();
    }
    // Touch 1 so 2 becomes the oldest, then add 3.
    expect(projection.get(1)).toBe(2);
    projection.get(3);
    scheduler.flush();
    expect(computed).toBe(3);

    expect(projection.get(1)).toBe(2); // still cached
    expect(scheduler.queued).toBe(false);
  });
});

describe('cancellable', () => {
  it('a disposed scope stops delivery and stops computing', () => {
    const scheduler = manualScheduler();
    const projection = createLayoutProjection(controller.signal, scheduler.schedule);
    const seen: PlankLayout[] = [];
    projection.subscribe((layout) => seen.push(layout));

    projection.get(inputsFor(20));
    controller.abort(); // the activation scope going away
    scheduler.flush();

    expect(projection.computations).toBe(0);
    expect(seen).toHaveLength(0);
  });

  it('subscribing after disposal is a no-op rather than a leak', () => {
    const projection = createLayoutProjection(controller.signal, manualScheduler().schedule);
    controller.abort();
    const stop = projection.subscribe(() => {
      throw new Error('must not be called');
    });
    projection.get(inputsFor(20));
    expect(() => stop()).not.toThrow();
  });

  it('the engine itself honours the signal, so a long run stops mid-way', () => {
    const aborted = new AbortController();
    aborted.abort();
    expect(computePlankLayout(inputsFor(20), aborted.signal).planks).toHaveLength(0);
  });
});

describe('last-good-wins', () => {
  it('a miss serves the previous layout rather than nothing', () => {
    const scheduler = manualScheduler();
    const projection = createLayoutProjection(controller.signal, scheduler.schedule);

    projection.get(inputsFor(20));
    scheduler.flush();
    const good = projection.get(inputsFor(20))!;

    // A wall drag: a brand new key, not yet computed.
    const stale = projection.get(inputsFor(20.5));
    expect(stale).toBe(good);
    expect(stale!.planks.length).toBeGreaterThan(0);
  });

  it('dragging a wall never blocks and never coalesces to more than one computation', () => {
    const scheduler = manualScheduler();
    const projection = createLayoutProjection(controller.signal, scheduler.schedule);

    projection.get(inputsFor(20));
    scheduler.flush();
    const before = projection.computations;

    // 120 pointer moves, i.e. two seconds of dragging a wall at 60 Hz.
    let served = 0;
    for (let frame = 0; frame < 120; frame++) {
      const layout = projection.get(inputsFor(20 + frame * 0.01));
      if (layout) served += 1;
    }

    // Not one computation ran on the frame path — that is the whole acceptance criterion.
    expect(projection.computations).toBe(before);
    // And every frame had a floor to draw.
    expect(served).toBe(120);

    scheduler.flush();
    expect(projection.computations).toBe(before + 1);
  });

  it('the computation that runs is the newest one asked for, not the first', () => {
    const scheduler = manualScheduler();
    const projection = createLayoutProjection(controller.signal, scheduler.schedule);
    projection.get(inputsFor(20));
    projection.get(inputsFor(30));
    scheduler.flush();
    expect(projection.computations).toBe(1);
    expect(projection.get(inputsFor(30))!.key).toBe(layoutKey(inputsFor(30)));
  });
});

describe('relocatable', () => {
  it('no caller assumes the work happens on this thread or in this tick', () => {
    // A scheduler that never runs anything is the degenerate "it went to a worker and the
    // worker is busy" case. Every `get` must still answer.
    const projection = createLayoutProjection(controller.signal, () => () => {});
    for (let i = 0; i < 10; i++) {
      expect(() => projection.get(inputsFor(20 + i))).not.toThrow();
    }
    expect(projection.computations).toBe(0);
  });

  it('the result arrives through subscribe, which is the only delivery path', async () => {
    const delivered: PlankLayout[] = [];
    // The default scheduler: a macrotask, so the frame paints first.
    const projection = createLayoutProjection(controller.signal);
    projection.subscribe((layout) => delivered.push(layout));

    expect(projection.get(inputsFor(20))).toBeNull();
    expect(delivered).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(delivered).toHaveLength(1);
    expect(delivered[0].planks.length).toBeGreaterThan(0);
  });

  it('compute is an ordinary pure function of the narrow inputs, so it can move', () => {
    // Nothing in `computePlankLayout`'s signature mentions a store, a document or a view.
    const inputs = inputsFor(20);
    const a = computePlankLayout(inputs);
    const b = computePlankLayout(JSON.parse(JSON.stringify(inputs)) as LayoutInputs);
    expect(a.planks.length).toBe(b.planks.length);
    expect(a.key).toBe(b.key);
    expect(a.wastePercent).toBeCloseTo(b.wastePercent, 9);
  });
});
