import type { ModuleBlob } from '../types/module';
import { ValidationError } from './ValidationError';

/**
 * The on-disk shape, never used by the editor.
 *
 * Two types rather than persisting `EditorDocument` directly: the envelope carries schema
 * versions, omitted defaults, quarantined blobs, drift flags, and permanent legacy shapes,
 * none of which the editor should be able to name.
 *
 * Everything here is `unknown` above the module map. Validation is `documentCodec`'s job; this
 * file only decides *where* things are.
 */

export const ENVELOPE_VERSION = 3;

export interface DocumentEnvelopeV3 {
  version: 3;
  geometry: unknown;
  space?: unknown;
  displayPreferences?: unknown;
  modules: Record<string, ModuleBlob>;
  /** Recorded beside a quarantined blob, never inside it. */
  quarantineFlags?: Record<string, { geometryChangedSinceLoad: boolean }>;
}

/**
 * The one place core names a module id, and it is permanent: the legacy on-disk format
 * predates modules, so `lights`, `rafterConfig` and `lightDefinitions` have nowhere else to
 * go. A v1/v2 reader is a historical fact, not an extension point — a new module never adds a
 * case here.
 */
const LEGACY_LIGHTING_MODULE_ID = 'lighting';
const LEGACY_LIGHTING_SCHEMA_VERSION = 1;

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalize any accepted on-disk shape to a v3 envelope.
 *
 * Readers for envelope 1 and 2 are **permanent, not transitional** — legacy share URLs encode
 * them, and so does every `localStorage` key written before this phase.
 */
export function toEnvelopeV3(raw: unknown): DocumentEnvelopeV3 {
  if (!isRecord(raw)) {
    throw new ValidationError('Invalid data format: expected an object');
  }

  if (raw.version === ENVELOPE_VERSION) {
    return readV3(raw);
  }

  // `{ version: 1 | 2, roomState, lightDefinitions }`. The number versions the *light
  // definition envelope*, not the document schema — 1 and 2 read identically, and 1 simply
  // predates most documents carrying a non-empty `lightDefinitions`.
  if ((raw.version === 1 || raw.version === 2) && isRecord(raw.roomState)) {
    return fromLegacyRoomState(raw.roomState, raw.lightDefinitions);
  }

  // Unversioned flat `RoomState`. This is what local storage has always written, and it is the
  // weakest input the codec sees.
  return fromLegacyRoomState(raw, undefined);
}

function readV3(raw: Rec): DocumentEnvelopeV3 {
  const envelope: DocumentEnvelopeV3 = {
    version: 3,
    geometry: raw.geometry,
    modules: readModuleMap(raw.modules),
  };
  if (raw.space !== undefined) envelope.space = raw.space;
  if (raw.displayPreferences !== undefined) envelope.displayPreferences = raw.displayPreferences;
  return envelope;
}

/**
 * Coerce the module map without judging any payload. A structurally broken entry keeps its
 * value under a `v` no codec can accept, so it quarantines as `invalid` and is written back
 * rather than dropped — `quarantineFlags` on the way out are the codec's business, not this
 * file's.
 */
function readModuleMap(raw: unknown): Record<string, ModuleBlob> {
  if (!isRecord(raw)) return {};
  const modules: Record<string, ModuleBlob> = {};
  for (const [id, entry] of Object.entries(raw)) {
    if (isRecord(entry) && typeof entry.v === 'number') {
      modules[id] = { v: entry.v, data: entry.data };
    } else {
      modules[id] = { v: 0, data: entry };
    }
  }
  return modules;
}

function fromLegacyRoomState(state: Rec, lightDefinitions: unknown): DocumentEnvelopeV3 {
  const lighting: Rec = {
    fixtures: state.lights ?? [],
    definitions: Array.isArray(lightDefinitions) ? lightDefinitions : [],
  };
  if (state.rafterConfig !== undefined) lighting.rafterConfig = state.rafterConfig;

  const envelope: DocumentEnvelopeV3 = {
    version: 3,
    geometry: {
      boundary: { walls: state.walls, isClosed: state.isClosed },
      doors: state.doors ?? [],
      obstacles: state.obstacles ?? [],
    },
    space: { ceilingHeight: state.ceilingHeight },
    modules: {
      [LEGACY_LIGHTING_MODULE_ID]: { v: LEGACY_LIGHTING_SCHEMA_VERSION, data: lighting },
    },
  };
  if (state.displayPreferences !== undefined) {
    envelope.displayPreferences = state.displayPreferences;
  }
  return envelope;
}
