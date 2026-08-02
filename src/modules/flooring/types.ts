import type { Vector2 } from '../../floorplan/types/geometry';

/**
 * The flooring module's domain types. **Eager-safe**: plain data and constants only, no
 * `three`, no `*.svelte`, no store. `codec.ts` and `commands.ts` import this, and they are in
 * the initial chunk because persistence is synchronous (invariant 7).
 *
 * Units: the document's geometry is in **feet**; a plank is specified in **inches**, because
 * that is how a plank is sold and how a cut list is read. Every conversion happens in
 * `PlankLayoutEngine`, at one place, and nothing outside it mixes the two.
 */

/** One SKU: the board being installed. */
export interface PlankSpec {
  /** Face width, inches. LVP is typically 5–9". */
  widthIn: number;
  /** Face length, inches. Typically 36–60". */
  lengthIn: number;
  /** What the box says. Shown in the cut list header; not an id. */
  name: string;
}

/**
 * How rows are offset from one another.
 *
 * `pattern` cycles `rowOffsetPattern`; `random` is deterministic in `seed`, so a layout is a
 * pure function of its inputs and undo/redo across a config change is a cache hit rather than a
 * different-looking floor.
 */
export type StaggerRule = 'none' | 'half' | 'thirds' | 'pattern' | 'random';

/** Which corner of the run-aligned room the first row and first plank start from. */
export type StartCorner = 'bottomLeft' | 'bottomRight' | 'topLeft' | 'topRight';

export interface LayoutConfig {
  /** Run direction in degrees CCW from +X. Rows are perpendicular to it. */
  runAngleDeg: number;
  startCorner: StartCorner;
  stagger: StaggerRule;
  /** Shortest acceptable end piece, inches. A shorter one shifts the row instead. */
  minEndCutIn: number;
  /** Perimeter gap left for expansion, inches. */
  expansionGapIn: number;
  /** Row offsets as fractions of plank length, cycled. Used when `stagger` is `pattern`. */
  rowOffsetPattern: number[];
  /** Seed for `stagger: 'random'`. Persisted, so the floor is reproducible. */
  seed: number;
}

/** A threshold where this floor meets something else. Anchored to a `Door` (see below). */
export type TransitionKind = 'threshold' | 'reducer' | 'tMolding';

/**
 * A transition anchored to a core `Door`.
 *
 * This is the plan's "doors are already thresholds" claim cashed in: a `Transition` carries no
 * geometry of its own — no wall id, no offset, no width — because `Door` already has all three.
 * The transition is the *decision* to trim that opening, and it dies with its door
 * (`transitionsForDoors` prunes orphans on decode and on every write).
 */
export interface Transition {
  id: string;
  doorId: string;
  kind: TransitionKind;
}

export const DEFAULT_PLANK_SPEC: PlankSpec = {
  widthIn: 7,
  lengthIn: 48,
  name: '7" x 48" LVP',
};

export const DEFAULT_LAYOUT_CONFIG: LayoutConfig = {
  runAngleDeg: 0,
  startCorner: 'bottomLeft',
  stagger: 'thirds',
  minEndCutIn: 8,
  expansionGapIn: 0.25,
  rowOffsetPattern: [0, 0.33, 0.66],
  seed: 1,
};

export const DEFAULT_LAYOUT_ORIGIN: Vector2 = { x: 0, y: 0 };

/** Plank sizes the tool panel offers. Any width/length is legal; these are the common ones. */
export const PLANK_PRESETS: readonly PlankSpec[] = [
  { widthIn: 5, lengthIn: 48, name: '5" x 48" LVP' },
  { widthIn: 6, lengthIn: 48, name: '6" x 48" LVP' },
  { widthIn: 7, lengthIn: 48, name: '7" x 48" LVP' },
  { widthIn: 7, lengthIn: 60, name: '7" x 60" LVP' },
  { widthIn: 9, lengthIn: 60, name: '9" x 60" plank' },
  { widthIn: 2.25, lengthIn: 36, name: '2 1/4" strip oak' },
];

export const STAGGER_LABELS: Readonly<Record<StaggerRule, string>> = {
  none: 'Aligned (no stagger)',
  half: 'Half offset (1/2)',
  thirds: 'Third offset (1/3)',
  pattern: 'Custom pattern',
  random: 'Randomized',
};

export const START_CORNER_LABELS: Readonly<Record<StartCorner, string>> = {
  bottomLeft: 'Bottom left',
  bottomRight: 'Bottom right',
  topLeft: 'Top left',
  topRight: 'Top right',
};

export const TRANSITION_LABELS: Readonly<Record<TransitionKind, string>> = {
  threshold: 'Threshold',
  reducer: 'Reducer',
  tMolding: 'T-molding',
};

export const INCHES_PER_FOOT = 12;

/**
 * Hard ceiling on generated pieces. A degenerate config (a 0.01" plank in a 40' room) would
 * otherwise generate millions of instances and hang the tab; the engine stops and reports
 * `truncated` instead, which the summary panel surfaces.
 */
export const MAX_PLANKS = 20000;
