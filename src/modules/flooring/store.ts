import { writable, type Readable, type Writable } from 'svelte/store';
import type { EditorDocument } from '../../floorplan/types/document';
import { readModule } from '../../floorplan/types/module';
import { committedDocument, roomStore, sessionStore } from '../../floorplan/stores/sessionStore';
import { documentSlice } from '../../floorplan/stores/documentSlice';
import { generateId } from '../../floorplan/utils/id';
import type { FlooringData } from './codec';
import { flooringCodec } from './codec';
import {
  addTransition,
  configureLayout,
  moveOrigin,
  removeTransition,
  setPlankSpec,
} from './commands';
import type { LayoutConfig, PlankSpec, TransitionKind } from './types';
import type { LayoutInputs, Plank, PlankLayout } from './PlankLayoutEngine';
import { EMPTY_LAYOUT } from './PlankLayoutEngine';
import { PlankIndex } from './PlankIndex';
import { createLayoutProjection, type LayoutProjection } from './layoutProjection';

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
