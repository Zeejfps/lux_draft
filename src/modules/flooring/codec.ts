import type { Vector2 } from '../../floorplan/types/geometry';
import type { DecodeResult, ModuleBlob, ModuleCodec } from '../../floorplan/types/module';
import type {
  Divider,
  LayoutConfig,
  LayoutPin,
  LayoutPins,
  PlankSpec,
  StaggerRule,
  StartCorner,
  SurfaceAssignment,
  SurfaceKind,
  Transition,
  TransitionKind,
} from './types';
import {
  DEFAULT_LAYOUT_CONFIG,
  DEFAULT_LAYOUT_ORIGIN,
  DEFAULT_PLANK_SPEC,
  STAGGER_LABELS,
  START_CORNER_LABELS,
  SURFACE_LABELS,
  TRANSITION_LABELS,
} from './types';

/**
 * The flooring module's data schema and codec. **Eager** (invariant 7): no `three`, no
 * `*.svelte`, no `runtime.ts`, no store — `decodeDocument` is synchronous and runs before any
 * runtime is imported.
 *
 * What is *not* here is the point of the phase: no planks, no cut list, no waste figure and no
 * square footage. Those are a pure function of `(boundary, obstacles, plank, layout, origin)`
 * and are derived on demand by `PlankLayoutEngine` (invariant 5). Storing them would put
 * thousands of objects into each of 50 history snapshots and would make undo step through
 * machine output instead of user intent.
 */

export const FLOORING_MODULE_ID = 'flooring';

/**
 * Bumped by this module alone. The envelope version and other modules are unaffected.
 *
 * v2 adds `dividers` and `surfaces`. Both default to empty, and empty means "one area, plank" —
 * so a v1 document decodes to the floor it always had, and this build reads it without a
 * migration step.
 *
 * `pins` arrived after v2 and did **not** bump this. It is additive and absent-tolerant like the
 * optional arrays already here, and a bump is not free in the direction that matters: it makes
 * new documents *unreadable* by older builds, which is strictly worse than an older build
 * rendering the same floor unpinned.
 */
export const FLOORING_SCHEMA_VERSION = 2;

/**
 * Everything the flooring module owns. Four small values; the floor itself is derived.
 *
 * `origin` is the point every row and every plank joint is measured from — the corner the
 * installer starts at. It is a `Vector2` in room coordinates and it is what `flooring.origin`
 * contributes to core's entity seam, so it drags, snaps and box-selects like anything else.
 */
export interface FlooringData {
  plank: PlankSpec;
  layout: LayoutConfig;
  origin: Vector2;
  transitions: Transition[];
  /**
   * Where the floor changes, in document order. Order matters: `RegionSolver` applies them in
   * sequence, so a divider that lands on an earlier one T-joins it, and one that would need a
   * later divider to exist first does not attach.
   */
  dividers: Divider[];
  /**
   * Which area is which surface, stored against a seed point rather than a face id — faces are
   * derived and have no id to store. An empty list is the whole room in plank.
   */
  surfaces: SurfaceAssignment[];
  /**
   * Board sizes the user asked for, as grid phases rather than as geometry.
   *
   * Top-level rather than a field on `LayoutConfig` because `configureLayout` is a whole-form
   * absolute write from the layout panel: a pin set from the board panel would be clobbered by
   * the next edit of any field on that form. Same reason `surfaces` sits here, and it gets its
   * own command for the same reason too.
   */
  pins: LayoutPins;
}

/** Freshly allocated on every call, all the way down. Never share a literal. */
export function defaultFlooringData(): FlooringData {
  return {
    plank: { ...DEFAULT_PLANK_SPEC },
    layout: {
      ...DEFAULT_LAYOUT_CONFIG,
      rowOffsetPattern: [...DEFAULT_LAYOUT_CONFIG.rowOffsetPattern],
    },
    origin: { ...DEFAULT_LAYOUT_ORIGIN },
    transitions: [],
    dividers: [],
    surfaces: [],
    pins: {},
  };
}

/** Freshly allocated, all the way down — a pin holds a `Vector2` and must never be aliased. */
export function clonePins(pins: Readonly<LayoutPins>): LayoutPins {
  const out: LayoutPins = {};
  if (pins.rip) out.rip = { ...pins.rip, seed: { ...pins.rip.seed } };
  if (pins.joint) out.joint = { ...pins.joint, seed: { ...pins.joint.seed } };
  return out;
}

/**
 * Transitions whose door still exists.
 *
 * A `Transition` carries no geometry — it points at a `Door`, which already has the wall id,
 * the offset along the wall and the width a threshold needs. That is the plan's "doors are
 * already thresholds" claim, and the cost of it is exactly this function: a door the user
 * deletes leaves an inert transition behind, and every consumer resolves through here rather
 * than trusting the id. Nothing prunes the document, because a door delete is a **core**
 * command and a core command may not rewrite a module's slice.
 */
export function liveTransitions(
  transitions: readonly Transition[],
  doors: readonly { id: string }[]
): Transition[] {
  const known = new Set(doors.map((door) => door.id));
  return transitions.filter((transition) => known.has(transition.doorId));
}

// ============================================
// Validation
// ============================================

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

class SliceInvalid extends Error {}

function fail(message: string): never {
  throw new SliceInvalid(message);
}

/**
 * Sub-configs merge onto a fresh default field by field rather than failing, exactly as
 * lighting's do: a document written before a field existed must decode clean, not quarantine.
 * The arrays and enums are checked strictly, because a bad one would reach the engine.
 */
function readPlank(value: unknown): PlankSpec {
  const base = { ...DEFAULT_PLANK_SPEC };
  if (value === undefined || value === null) return base;
  if (!isRecord(value)) fail('plank must be an object');
  if (isFiniteNumber(value.widthIn)) {
    if (value.widthIn <= 0) fail('plank.widthIn must be greater than zero');
    base.widthIn = value.widthIn;
  }
  if (isFiniteNumber(value.lengthIn)) {
    if (value.lengthIn <= 0) fail('plank.lengthIn must be greater than zero');
    base.lengthIn = value.lengthIn;
  }
  if (isFiniteNumber(value.minRipWidthIn)) {
    if (value.minRipWidthIn < 0) fail('plank.minRipWidthIn must not be negative');
    base.minRipWidthIn = value.minRipWidthIn;
  }
  if (typeof value.name === 'string') base.name = value.name;
  return base;
}

function readLayout(value: unknown): LayoutConfig {
  const fresh = defaultFlooringData().layout;
  if (value === undefined || value === null) return fresh;
  if (!isRecord(value)) fail('layout must be an object');

  if (isFiniteNumber(value.runAngleDeg)) fresh.runAngleDeg = normalizeAngle(value.runAngleDeg);
  if (typeof value.startCorner === 'string') {
    if (!(value.startCorner in START_CORNER_LABELS)) {
      fail(`layout.startCorner "${value.startCorner}" is not a known corner`);
    }
    fresh.startCorner = value.startCorner as StartCorner;
  }
  if (typeof value.stagger === 'string') {
    if (!(value.stagger in STAGGER_LABELS)) {
      fail(`layout.stagger "${value.stagger}" is not a known stagger rule`);
    }
    fresh.stagger = value.stagger as StaggerRule;
  }
  if (isFiniteNumber(value.minEndCutIn)) {
    if (value.minEndCutIn < 0) fail('layout.minEndCutIn must not be negative');
    fresh.minEndCutIn = value.minEndCutIn;
  }
  if (isFiniteNumber(value.expansionGapIn)) {
    if (value.expansionGapIn < 0) fail('layout.expansionGapIn must not be negative');
    fresh.expansionGapIn = value.expansionGapIn;
  }
  if (value.rowOffsetPattern !== undefined) {
    if (!Array.isArray(value.rowOffsetPattern)) fail('layout.rowOffsetPattern must be an array');
    const pattern = value.rowOffsetPattern.map((entry, i) => {
      if (!isFiniteNumber(entry)) fail(`layout.rowOffsetPattern[${i}] must be a number`);
      return entry;
    });
    if (pattern.length > 0) fresh.rowOffsetPattern = pattern;
  }
  if (isFiniteNumber(value.seed)) fresh.seed = Math.trunc(value.seed);
  return fresh;
}

/** Keep the persisted angle in `[0, 180)` — a run at 190° is the run at 10°. */
export function normalizeAngle(degrees: number): number {
  const wrapped = degrees % 180;
  return wrapped < 0 ? wrapped + 180 : wrapped;
}

function readOrigin(value: unknown): Vector2 {
  if (value === undefined || value === null) return { ...DEFAULT_LAYOUT_ORIGIN };
  return readVector2(value, 'origin');
}

function readTransition(value: unknown, path: string): Transition {
  if (!isRecord(value)) fail(`${path} must be an object`);
  if (typeof value.id !== 'string' || value.id === '') fail(`${path}.id must be a string`);
  if (typeof value.doorId !== 'string' || value.doorId === '') {
    fail(`${path}.doorId must be a string`);
  }
  if (typeof value.kind !== 'string' || !(value.kind in TRANSITION_LABELS)) {
    fail(`${path}.kind "${String(value.kind)}" is not a known transition kind`);
  }
  return { id: value.id, doorId: value.doorId, kind: value.kind as TransitionKind };
}

function readVector2(value: unknown, path: string): Vector2 {
  if (!isRecord(value)) fail(`${path} must be an object`);
  if (!isFiniteNumber(value.x) || !isFiniteNumber(value.y)) fail(`${path} must have numeric x/y`);
  return { x: value.x, y: value.y };
}

function readDivider(value: unknown, path: string): Divider {
  if (!isRecord(value)) fail(`${path} must be an object`);
  if (typeof value.id !== 'string' || value.id === '') fail(`${path}.id must be a string`);
  if (typeof value.kind !== 'string' || !(value.kind in TRANSITION_LABELS)) {
    fail(`${path}.kind "${String(value.kind)}" is not a known transition kind`);
  }
  const a = readVector2(value.a, `${path}.a`);
  const b = readVector2(value.b, `${path}.b`);
  // A zero-length divider cannot split anything and would make the solver's normal undefined.
  if (Math.hypot(b.x - a.x, b.y - a.y) <= 0) fail(`${path} has zero length`);
  return { id: value.id, a, b, kind: value.kind as TransitionKind };
}

function readSurfaceAssignment(value: unknown, path: string): SurfaceAssignment {
  if (!isRecord(value)) fail(`${path} must be an object`);
  if (typeof value.surface !== 'string' || !(value.surface in SURFACE_LABELS)) {
    fail(`${path}.surface "${String(value.surface)}" is not a known surface`);
  }
  return {
    seed: readVector2(value.seed, `${path}.seed`),
    surface: value.surface as SurfaceKind,
  };
}

function readPin(value: unknown, path: string): LayoutPin {
  if (!isRecord(value)) fail(`${path} must be an object`);
  if (!isFiniteNumber(value.targetIn) || value.targetIn <= 0) {
    fail(`${path}.targetIn must be a positive number`);
  }
  if (value.edge !== 'low' && value.edge !== 'high') {
    fail(`${path}.edge "${String(value.edge)}" is not a boundary side`);
  }
  return {
    seed: readVector2(value.seed, `${path}.seed`),
    targetIn: value.targetIn,
    edge: value.edge,
  };
}

/**
 * Absent decodes to no pins, which is the floor every document written before this existed had.
 * A malformed pin is quarantined rather than dropped: it moves geometry, so silently reading it
 * as "unpinned" would render a different floor than the one that was saved and say nothing.
 */
function readPins(value: unknown): LayoutPins {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) fail('pins must be an object');
  const out: LayoutPins = {};
  if (value.rip !== undefined && value.rip !== null) out.rip = readPin(value.rip, 'pins.rip');
  if (value.joint !== undefined && value.joint !== null) {
    out.joint = readPin(value.joint, 'pins.joint');
  }
  return out;
}

function decodeFlooring(blob: ModuleBlob): DecodeResult<FlooringData> {
  if (!Number.isInteger(blob.v) || blob.v < 1) {
    return {
      status: 'invalid',
      message: `flooring slice has no usable schema version (v=${JSON.stringify(blob.v)})`,
    };
  }
  if (blob.v > FLOORING_SCHEMA_VERSION) {
    return {
      status: 'unsupported',
      writtenVersion: blob.v,
      message:
        `flooring data was written at schema version ${blob.v}; this build reads up to ` +
        `${FLOORING_SCHEMA_VERSION}`,
    };
  }

  try {
    if (!isRecord(blob.data)) fail('flooring slice must be an object');
    const raw = blob.data;

    if (raw.transitions !== undefined && !Array.isArray(raw.transitions)) {
      fail('transitions must be an array');
    }
    const transitions = ((raw.transitions as unknown[]) ?? []).map((t, i) =>
      readTransition(t, `transitions[${i}]`)
    );
    const seen = new Set<string>();
    for (const transition of transitions) {
      if (seen.has(transition.id)) fail(`duplicate transition id "${transition.id}"`);
      seen.add(transition.id);
    }

    if (raw.dividers !== undefined && !Array.isArray(raw.dividers)) {
      fail('dividers must be an array');
    }
    const dividers = ((raw.dividers as unknown[]) ?? []).map((d, i) =>
      readDivider(d, `dividers[${i}]`)
    );
    const dividerIds = new Set<string>();
    for (const divider of dividers) {
      if (dividerIds.has(divider.id)) fail(`duplicate divider id "${divider.id}"`);
      dividerIds.add(divider.id);
    }

    if (raw.surfaces !== undefined && !Array.isArray(raw.surfaces)) {
      fail('surfaces must be an array');
    }
    const surfaces = ((raw.surfaces as unknown[]) ?? []).map((s, i) =>
      readSurfaceAssignment(s, `surfaces[${i}]`)
    );

    return {
      status: 'ok',
      data: {
        plank: readPlank(raw.plank),
        layout: readLayout(raw.layout),
        origin: readOrigin(raw.origin),
        transitions,
        dividers,
        surfaces,
        pins: readPins(raw.pins),
      },
    };
  } catch (e) {
    if (e instanceof SliceInvalid) return { status: 'invalid', message: e.message };
    throw e;
  }
}

/**
 * A share link is a single-module view. Everything flooring owns is needed to redraw the
 * floor — the whole slice is four small values and no part of it is authoring-only — so this
 * is a deep copy rather than a projection. It still exists, because the contract requires the
 * result to be written at `schemaVersion` and read back by `decodeFlooring`, and a copy is what
 * guarantees the shared payload cannot alias the live document.
 */
function compactFlooringForShare(data: Readonly<FlooringData>): FlooringData {
  return {
    plank: { ...data.plank },
    layout: { ...data.layout, rowOffsetPattern: [...data.layout.rowOffsetPattern] },
    origin: { ...data.origin },
    transitions: data.transitions.map((t) => ({ ...t })),
    dividers: data.dividers.map((d) => ({ ...d, a: { ...d.a }, b: { ...d.b } })),
    surfaces: data.surfaces.map((s) => ({ ...s, seed: { ...s.seed } })),
    pins: clonePins(data.pins),
  };
}

export const flooringCodec: ModuleCodec<FlooringData> = {
  id: FLOORING_MODULE_ID,
  schemaVersion: FLOORING_SCHEMA_VERSION,
  defaultData: defaultFlooringData,
  decode: decodeFlooring,
  compactForShare: compactFlooringForShare,
};
