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

/**
 * What covers one area of the room. This module lays `plank`; the rest name what it *isn't*, so
 * that the boundary between them can be drawn as a transition.
 *
 * `none` is bare subfloor — an area deliberately left out of the scope of the job.
 */
export type SurfaceKind = 'plank' | 'carpet' | 'tile' | 'none';

/**
 * A straight cut across the room where the floor changes.
 *
 * This is the **authored** object, and the areas either side of it are derived from it — the
 * same trade the module already makes for planks (invariant 5). Authoring the area instead
 * would store a polygon that drifts away from the walls the moment one is dragged, and would
 * still not say where the transition goes; authoring the line says both.
 *
 * `a` and `b` are room coordinates in feet, expected to land on the room's boundary or on
 * another divider. `RegionSolver` projects them onto whichever face they touch, so an endpoint
 * dropped a few inches off a wall still splits the room; one dropped in open space does not,
 * and is reported as unattached rather than silently ignored.
 */
export interface Divider {
  id: string;
  a: Vector2;
  b: Vector2;
  /** The trim that covers the joint. Purely presentational; it does not affect the layout. */
  kind: TransitionKind;
}

/**
 * "The area containing this point is carpet."
 *
 * A derived face has no id to hang this on, so the assignment is stored against a **seed
 * point** and resolved by containment. A seed survives a wall drag, a divider move and an undo;
 * a face that stops existing simply stops matching, and the stale assignment is inert rather
 * than wrong. Faces with no matching seed inherit from the face they were split out of, and the
 * room with no dividers at all is one face of `plank` — which is exactly the pre-divider
 * behaviour, so a document written before this existed decodes to the same floor.
 */
export interface SurfaceAssignment {
  seed: Vector2;
  surface: SurfaceKind;
}

export const DEFAULT_SURFACE: SurfaceKind = 'plank';

export const SURFACE_LABELS: Readonly<Record<SurfaceKind, string>> = {
  plank: 'This floor (plank)',
  carpet: 'Carpet',
  tile: 'Tile',
  none: 'Not floored',
};

/**
 * How far a divider endpoint may sit from a face's boundary and still attach to it, in feet.
 *
 * Generous on purpose: the placement tool projects a click onto the boundary anyway, so this
 * only has to absorb the drift left by a later wall edit.
 */
export const DIVIDER_ATTACH_TOLERANCE_FT = 0.75;

/**
 * How far off a divider the solver probes to read the surface on each side, in feet.
 *
 * Small enough to stay inside the thinnest area anyone would draw, large enough to clear the
 * even-odd rule's ambiguity for a point sitting exactly on an edge.
 */
export const SURFACE_PROBE_FT = 0.02;

/** Sanity ceiling on authored dividers; each one splits one face, so the face count is bounded. */
export const MAX_DIVIDERS = 64;

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
