import { writable, type Readable, type Writable } from 'svelte/store';
import type { EditorDocument } from '../../floorplan/types/document';
import type { Vector2, WallSegment } from '../../floorplan/types/geometry';
import { readModule } from '../../floorplan/types/module';
import { committedDocument, roomStore, sessionStore } from '../../floorplan/stores/sessionStore';
import { documentSlice } from '../../floorplan/stores/documentSlice';
import { generateId } from '../../floorplan/utils/id';
import type { FlooringData } from './codec';
import { flooringCodec } from './codec';
import {
  addDivider,
  addTransition,
  configureLayout,
  moveOrigin,
  removeDivider,
  removeTransition,
  setDividerKind,
  setPlankSpec,
  setSurfaces,
} from './commands';
import type { LayoutConfig, PlankSpec, SurfaceKind, TransitionKind } from './types';
import type { LayoutInputs, Plank, PlankLayout } from './PlankLayoutEngine';
import { EMPTY_LAYOUT } from './PlankLayoutEngine';
import { PlankIndex } from './PlankIndex';
import type { RegionInputs, RegionSolution } from './RegionSolver';
import { EMPTY_SOLUTION } from './RegionSolver';
import { pointInPolygon } from './geometry2d';
import {
  createLayoutProjection,
  solveRegionsCached,
  type LayoutProjection,
} from './layoutProjection';

/**
 * The flooring module's read and write layer, plus the layout service.
 *
 * Reads are guarded projections of the session; writes are single registered `flooring.*`
 * commands. Nothing here is imported by `codec.ts` or `commands.ts` — this file pulls in
 * `svelte/store` and belongs to the lazy half.
 */

const readFlooring = (doc: EditorDocument): Readonly<FlooringData> =>
  readModule(doc, flooringCodec);

/** Live view — includes the candidate command of a drag in progress. What layers read. */
export const flooringData: Readable<Readonly<FlooringData>> = documentSlice(
  roomStore,
  readFlooring
);

/** Committed view. What panels that must not flicker mid-gesture read. */
export const committedFlooringData: Readable<Readonly<FlooringData>> = documentSlice(
  committedDocument,
  readFlooring
);

export const plankSpec: Readable<PlankSpec> = documentSlice(
  committedDocument,
  (doc) => readFlooring(doc).plank
);

export const layoutConfig: Readable<LayoutConfig> = documentSlice(
  committedDocument,
  (doc) => readFlooring(doc).layout
);

/** The current slice, read synchronously. Setters need it; prefer the stores for reads. */
function current(): Readonly<FlooringData> {
  return readFlooring(sessionStore.current().document);
}

const regionInputsFor = (doc: EditorDocument): RegionInputs => ({
  walls: doc.geometry.boundary.walls as WallSegment[],
  isClosed: doc.geometry.boundary.isClosed,
  dividers: readFlooring(doc).dividers,
  surfaces: readFlooring(doc).surfaces,
});

/**
 * The solved areas and the transitions between them.
 *
 * Built on the **live** room rather than the committed one, and deliberately: areas are a
 * read-out, not a form, so watching them re-split while a wall is dragged is the useful
 * behaviour — and it shares the one-entry memo with the scene layer, which is looking at the
 * same live document, so the pair costs one solve per frame rather than two.
 *
 * Guarded on the solution's key: a pointer move that changes nothing structural emits nothing.
 */
export const floorRegions: Readable<RegionSolution> = documentSlice(
  roomStore,
  (doc) => solveRegionsCached(regionInputsFor(doc)),
  (a, b) => a.key === b.key
);

// ============================================
// Session-local presentation state
// ============================================

/**
 * Overlay state that is deliberately **not** document data: which mode's read-outs are open is
 * not a property of the room, and putting it in the document would make opening a panel an
 * undoable edit. Same call the lighting module made for its stats panel.
 */
export const planksVisible: Writable<boolean> = writable(true);
export const layoutPanelVisible: Writable<boolean> = writable(true);
export const summaryVisible: Writable<boolean> = writable(false);

export function togglePlanks(): void {
  planksVisible.update((v) => !v);
}

export function toggleLayoutPanel(): void {
  layoutPanelVisible.update((v) => !v);
}

export function toggleSummary(): void {
  summaryVisible.update((v) => !v);
}

/** The plank under the cursor. Fed by `PlankHoverHandler` through the spatial index. */
export const hoveredPlank: Writable<Plank | null> = writable(null);

// ============================================
// The layout service
// ============================================

/**
 * The derived floor. **Never stored** (invariant 5) — this is a session-scoped store fed by the
 * projection, it has no field on `FlooringData`, no persistence API accepts it, and the codec
 * round-trip test asserts the persisted shape.
 */
const layoutStore = writable<PlankLayout>(EMPTY_LAYOUT);
export const plankLayout: Readable<PlankLayout> = { subscribe: layoutStore.subscribe };

let projection: LayoutProjection | null = null;
let latest: PlankLayout = EMPTY_LAYOUT;
let index: PlankIndex | null = null;

function publish(layout: PlankLayout): void {
  if (layout === latest) return;
  latest = layout;
  // The index is rebuilt lazily, on the first hit-test after a new layout — a floor nobody
  // hovers never pays for one.
  index = null;
  layoutStore.set(layout);
}

/**
 * Start the projection for one activation. The scope owns the returned disposer *and* aborts
 * the signal, so a mode switch mid-computation drops the work rather than delivering it into a
 * disposed renderer.
 */
export function startLayoutService(
  signal: AbortSignal,
  schedule?: (run: () => void) => () => void
): () => void {
  projection = createLayoutProjection(signal, schedule);
  const stop = projection.subscribe(publish);
  return () => {
    stop();
    projection = null;
    index = null;
    latest = EMPTY_LAYOUT;
    layoutStore.set(EMPTY_LAYOUT);
  };
}

/**
 * Ask for the floor for these inputs. **Never blocks**: a cache hit is exact, a miss is the
 * last good floor plus a scheduled computation. Returns null only before the service starts.
 */
export function requestLayout(inputs: LayoutInputs): PlankLayout | null {
  const layout = projection?.get(inputs) ?? null;
  // A cache hit comes back synchronously and never reaches `subscribe`, so publish it here.
  if (layout) publish(layout);
  return layout;
}

/** The spatial index over the current floor, built on demand. */
export function currentPlankIndex(): PlankIndex | null {
  if (latest.planks.length === 0) return null;
  if (!index) index = new PlankIndex(latest);
  return index;
}

/** Computations actually run, for the projection's acceptance tests. */
export function layoutComputations(): number {
  return projection?.computations ?? 0;
}

// ============================================
// Writes — one registered command each
// ============================================

export function updateLayoutConfig(changes: Partial<LayoutConfig>): void {
  sessionStore.dispatch(configureLayout.make({ config: { ...current().layout, ...changes } }));
}

export function setOrigin(position: { x: number; y: number }): void {
  sessionStore.dispatch(moveOrigin.make({ position: { ...position } }));
}

export function setPlank(plank: PlankSpec): void {
  sessionStore.dispatch(setPlankSpec.make({ plank: { ...plank } }));
}

export function addDoorTransition(doorId: string, kind: TransitionKind = 'threshold'): void {
  sessionStore.dispatch(
    addTransition.make({ transition: { id: `transition-${generateId()}`, doorId, kind } })
  );
}

export function removeDoorTransition(transitionId: string): void {
  sessionStore.dispatch(removeTransition.make({ transitionId }));
}

// ============================================
// Dividers and surfaces
// ============================================

/**
 * The divider being drawn: its first endpoint, and where the pointer is now.
 *
 * Session-local, like every other in-flight gesture — an unfinished line is not a property of
 * the room and must not enter the undo stack.
 */
export const pendingDivider: Writable<{ from: Vector2; to: Vector2 } | null> = writable(null);

export function addFloorDivider(a: Vector2, b: Vector2, kind: TransitionKind = 'tMolding'): void {
  sessionStore.dispatch(
    addDivider.make({
      divider: { id: `divider-${generateId()}`, a: { ...a }, b: { ...b }, kind },
    })
  );
}

export function setFloorDividerKind(dividerId: string, kind: TransitionKind): void {
  sessionStore.dispatch(setDividerKind.make({ dividerId, kind }));
}

export function removeFloorDivider(dividerId: string): void {
  sessionStore.dispatch(removeDivider.make({ dividerId }));
}

/** The areas as they currently solve, read synchronously. */
export function currentRegions(): RegionSolution {
  const doc = sessionStore.current().document;
  return doc.geometry.boundary.isClosed ? solveRegionsCached(regionInputsFor(doc)) : EMPTY_SOLUTION;
}

/**
 * Assign a surface to the area containing `target`.
 *
 * The dispatched payload is the **whole** assignment list, rebuilt from the areas as they solve
 * right now. That is what resolves a derived face to a stored seed, and it prunes in passing:
 * an assignment left behind by a face that no longer exists is simply not carried forward.
 * A `target` in no area is a no-op rather than a stray assignment.
 */
export function setRegionSurface(target: Vector2, surface: SurfaceKind): void {
  const solution = currentRegions();
  const hit = solution.regions.find((region) => pointInPolygon(region.ring, target));
  if (!hit) return;
  sessionStore.dispatch(
    setSurfaces.make({
      surfaces: solution.regions.map((region) => ({
        seed: { ...region.seed },
        surface: region === hit ? surface : region.surface,
      })),
    })
  );
}
