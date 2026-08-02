import type { Obstacle, WallSegment } from '../../floorplan/types/geometry';
import type { ModuleView } from '../../floorplan/types/moduleRuntime';
import type { FlooringData } from './codec';
import type { LayoutInputs, PlankLayout } from './PlankLayoutEngine';
import { computePlankLayout, layoutKey } from './PlankLayoutEngine';
import type { RegionInputs, RegionSolution } from './RegionSolver';
import { plankRings, regionInputsKey, solveRegions } from './RegionSolver';

/**
 * The projection: how derived output reaches the screen without blocking a gesture.
 *
 * A Svelte `derived` store is not sufficient here, and that is the whole reason this file
 * exists. Recomputing a plank layout inside a subscription would run on every pointer move of a
 * wall drag — 60 times a second, over a room that may hold 700 planks — and it would run
 * *before* the frame paints, so the drag would stutter in exact proportion to the size of the
 * floor. The five requirements the plan sets out, and where each one is met:
 *
 * | Requirement       | Where                                                                     |
 * | ----------------- | ------------------------------------------------------------------------- |
 * | Narrow inputs     | `layoutInputsOf` — geometry + slice, never a `Session`, never a selection  |
 * | Keyed cache       | `key(inputs)`, an LRU keyed on the structural form (`layoutKey`)           |
 * | Cancellable       | `signal` — the activation scope's; aborts pending work and stops delivery  |
 * | Last-good-wins    | `get()` returns the previous layout while a new one computes              |
 * | Relocatable       | `schedule` + an output-only `subscribe`; no caller assumes synchrony       |
 *
 * `Projection<I, O>` is written here rather than in the core contract on purpose (ADR 0001
 * deferred it): this is the first and only consumer, and the shape it wants is knowable only
 * against a real engine. Promoting it into `floorplan/types/` is a file move if a second
 * consumer ever appears, and premature if one never does.
 */

export interface Projection<I, O> {
  /**
   * The best value available for these inputs, **without blocking**.
   *
   * A cache hit returns the exact answer. A miss returns the last good value — a stale floor
   * under a wall being dragged, rather than an empty one — and schedules the real computation,
   * whose result arrives through `subscribe`.
   */
  get(inputs: I): O | null;
  /** Called when a scheduled computation lands. Returns the unsubscribe. */
  subscribe(listener: (value: O) => void): () => void;
  /** Computations actually run. Test seam; the acceptance criteria are counts. */
  readonly computations: number;
}

export interface ProjectionOptions<I, O> {
  key(inputs: I): string;
  compute(inputs: I, signal: AbortSignal): O;
  /** The activation scope's signal. Aborting it cancels pending work and stops delivery. */
  signal: AbortSignal;
  /**
   * How a computation is deferred. Returns a canceller.
   *
   * **This is the relocation seam.** Nothing above it assumes the work happens on this thread
   * or in this tick: replacing this with a `postMessage` to a worker and resolving through the
   * same `subscribe` is a change inside this module and touches no caller.
   */
  schedule?: (run: () => void) => () => void;
  /** How many distinct input keys to remember. */
  cacheSize?: number;
}

/** A macrotask: after the current frame has had its chance to paint. */
const deferToMacrotask = (run: () => void): (() => void) => {
  const handle = setTimeout(run, 0);
  return () => clearTimeout(handle);
};

export function createProjection<I, O>(options: ProjectionOptions<I, O>): Projection<I, O> {
  const schedule = options.schedule ?? deferToMacrotask;
  const capacity = Math.max(1, options.cacheSize ?? 16);
  const cache = new Map<string, O>();
  const listeners = new Set<(value: O) => void>();

  let last: O | null = null;
  let pendingKey: string | null = null;
  let cancelPending: (() => void) | null = null;
  let computations = 0;

  function remember(key: string, value: O): void {
    // Insertion-order LRU. Re-inserting moves a hit to the young end, so undo/redo across a
    // config change keeps both layouts warm and both directions are hits.
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > capacity) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }

  function cancel(): void {
    cancelPending?.();
    cancelPending = null;
    pendingKey = null;
  }

  options.signal.addEventListener('abort', () => {
    cancel();
    listeners.clear();
  });

  return {
    get computations() {
      return computations;
    },

    get(inputs: I): O | null {
      if (options.signal.aborted) return last;

      const key = options.key(inputs);
      const hit = cache.get(key);
      if (hit !== undefined) {
        // A hit supersedes anything in flight: the answer is already known.
        if (pendingKey !== null && pendingKey !== key) cancel();
        remember(key, hit);
        last = hit;
        return hit;
      }

      if (pendingKey === key) return last;
      // A drag produces a new key every frame; only the newest is worth computing.
      cancel();
      pendingKey = key;
      cancelPending = schedule(() => {
        cancelPending = null;
        if (options.signal.aborted || pendingKey !== key) return;
        pendingKey = null;
        computations += 1;
        const value = options.compute(inputs, options.signal);
        if (options.signal.aborted) return;
        remember(key, value);
        last = value;
        for (const listener of listeners) listener(value);
      });

      return last;
    },

    subscribe(listener: (value: O) => void): () => void {
      if (options.signal.aborted) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// ============================================
// The flooring projection
// ============================================

/**
 * The narrow inputs, extracted from the view.
 *
 * Everything the layout depends on and **nothing else**: no selection, no view mode, no display
 * preferences, no session. That is not a comment, it is the reason selecting the origin marker
 * mid-drag does not throw the floor away — the key `layoutKey` computes cannot change when they
 * do, so the very next `get` is a cache hit.
 */
export function layoutInputsOf(view: ModuleView<FlooringData>): LayoutInputs {
  return {
    walls: view.geometry.boundary.walls as WallSegment[],
    isClosed: view.geometry.boundary.isClosed,
    obstacles: view.geometry.obstacles as Obstacle[],
    plank: view.data.plank,
    layout: view.data.layout,
    origin: view.data.origin,
    regions: plankRings(regionsOf(view)),
  };
}

// ============================================
// The region solution
// ============================================

/**
 * The solved areas for a view, memoized on one entry.
 *
 * `solveRegions` is cheap — a handful of chords and a point-in-polygon per face, not a floor's
 * worth of planks — so it does not need the machinery above. But it has *three* callers per
 * frame (the layer's `inputs` selector, the layer's `update`, and the panel's store) and it
 * allocates rings, so answering the same question three times would churn the heap at pointer
 * rate for no reason. One entry is the right size: every caller in a frame asks about the same
 * document, and the next frame supersedes it.
 *
 * Keyed on `regionInputsKey` rather than on the view, because a selection change or a hover
 * allocates a new view and must not invalidate the areas — the same discipline `layoutKey`
 * enforces one level up.
 */
let lastRegionKey: string | null = null;
let lastRegionSolution: RegionSolution | null = null;

export function regionInputsOf(view: ModuleView<FlooringData>): RegionInputs {
  return {
    walls: view.geometry.boundary.walls as WallSegment[],
    isClosed: view.geometry.boundary.isClosed,
    dividers: view.data.dividers,
    surfaces: view.data.surfaces,
  };
}

export function regionsOf(view: ModuleView<FlooringData>): RegionSolution {
  return solveRegionsCached(regionInputsOf(view));
}

export function solveRegionsCached(inputs: RegionInputs): RegionSolution {
  const key = regionInputsKey(inputs);
  if (lastRegionSolution && lastRegionKey === key) return lastRegionSolution;
  const solution = solveRegions(inputs);
  lastRegionKey = key;
  lastRegionSolution = solution;
  return solution;
}

export type LayoutProjection = Projection<LayoutInputs, PlankLayout>;

export function createLayoutProjection(
  signal: AbortSignal,
  schedule?: (run: () => void) => () => void
): LayoutProjection {
  return createProjection<LayoutInputs, PlankLayout>({
    key: layoutKey,
    compute: computePlankLayout,
    signal,
    schedule,
  });
}
