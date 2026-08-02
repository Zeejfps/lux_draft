import type { DeepReadonly } from '../types/deepReadonly';
import type { EditorDocument, FloorplanGeometry } from '../types/document';
import type { ModuleBlob } from '../types/module';
import type {
  CarriedState,
  Diagnostics,
  DocumentWarning,
  LoadedDocument,
  QuarantinedSlice,
} from '../types/session';
import { buildModuleSlices, hasModuleSlice, readModule } from '../types/module';
import { codecFor, registeredCodecs } from '../types/moduleRegistry';
import { valueEqual } from '../commands/serializable';
import type { DocumentEnvelopeV3 } from './envelope';
import { toEnvelopeV3 } from './envelope';
import { validateDisplayPreferences, validateGeometry, validateSpace } from './geometryValidation';

/**
 * The one document codec (invariant 9). All imports, local storage, exports, and share URLs
 * pass through it; it is the only code that sees hostile, legacy, or partial input, and
 * everything downstream receives a valid, normalized document.
 *
 * `decodeDocument` is **synchronous** — it touches only eagerly-imported codecs — so
 * `importFromString` and `decodeShareData` keep their signatures. `encodeDocument` takes
 * `carried` as a required positional parameter, so a save path that forgets it fails to
 * compile rather than silently dropping quarantined data.
 */

export type EncodeTarget =
  | { kind: 'file' }
  | { kind: 'local' }
  | { kind: 'share'; moduleId: string };

// ============================================
// Geometry fingerprint (staleness)
// ============================================

/** Stable key order, so the fingerprint depends on the value and not on how it was built. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/**
 * Structural hash of the shared drawing, captured at load and re-checked at save.
 *
 * Preserving a blob verbatim while the user reshapes the room means a future build may reopen
 * data authored for a different polygon — a flooring layout computed for the old room is wrong
 * in a way that looks authoritative — so the drift is recorded rather than guessed at later.
 */
export function geometryFingerprint(geometry: DeepReadonly<FloorplanGeometry>): string {
  const text = stableStringify(geometry);
  // FNV-1a, 32-bit. Cheap and stable across runs; this is a change detector, not a digest.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// ============================================
// Decode
// ============================================

/** A blob is carried verbatim; copy it so a later document edit cannot reach into it. */
function cloneBlob(blob: ModuleBlob): ModuleBlob {
  return {
    v: blob.v,
    data: blob.data === undefined ? undefined : JSON.parse(JSON.stringify(blob.data)),
  };
}

export function decodeDocument(raw: unknown): LoadedDocument {
  const envelope = toEnvelopeV3(raw);

  // The only rejection. Everything below quarantines instead (invariant 8).
  const geometry = validateGeometry(envelope.geometry);
  const space = validateSpace(envelope.space);
  const displayPreferences = validateDisplayPreferences(envelope.displayPreferences);

  const slices: Record<string, unknown> = {};
  const quarantined: Record<string, QuarantinedSlice> = {};
  const warnings: DocumentWarning[] = [];

  for (const codec of registeredCodecs()) {
    const blob = envelope.modules[codec.id];
    if (blob === undefined) {
      // Normalize on load: an absent slice materializes its default, so reads downstream are
      // ordinary field reads and visiting a mode for the first time is not an edit.
      slices[codec.id] = codec.defaultData();
      continue;
    }
    const result = codec.decode(blob);
    switch (result.status) {
      case 'ok':
        slices[codec.id] = result.data;
        break;
      case 'unsupported':
        quarantined[codec.id] = {
          blob: cloneBlob(blob),
          reason: 'unsupported',
          message: result.message,
        };
        warnings.push({
          moduleId: codec.id,
          message: `This document's ${codec.id} data was saved by a newer version of the app. It is preserved but cannot be edited here.`,
        });
        break;
      case 'invalid':
        quarantined[codec.id] = {
          blob: cloneBlob(blob),
          reason: 'invalid',
          message: result.message,
        };
        warnings.push({
          moduleId: codec.id,
          message: `This document's ${codec.id} data could not be read: ${result.message}. It is preserved but cannot be edited here.`,
        });
        break;
    }
  }

  for (const [id, blob] of Object.entries(envelope.modules)) {
    if (codecFor(id)) continue;
    // No warning: an unknown module id is expected in a single-module build, not a problem.
    quarantined[id] = { blob: cloneBlob(blob), reason: 'unknownModule' };
  }

  const document: EditorDocument = {
    geometry,
    space,
    modules: buildModuleSlices(slices),
    // LEGACY. Lighting still reads fixtures from the document root in phase 3a, but decode
    // already puts them in `modules.lighting`. Phase 3b deletes this field from
    // `EditorDocument` and the two lines that keep it here.
    lights: [],
  };
  if (displayPreferences) document.displayPreferences = displayPreferences;

  if (import.meta.env.DEV) {
    for (const id of Object.keys(quarantined)) {
      if (id in slices) {
        throw new Error(`Module "${id}" decoded both live and quarantined — decode is not total`);
      }
    }
  }

  const carried: CarriedState = {
    quarantined,
    geometryFingerprint: geometryFingerprint(geometry),
  };
  const diagnostics: Diagnostics = { warnings, runtimeStatus: {} };
  return { document, carried, diagnostics };
}

// ============================================
// Encode
// ============================================

export function encodeDocument(
  document: DeepReadonly<EditorDocument>,
  carried: DeepReadonly<CarriedState>,
  target: EncodeTarget
): DocumentEnvelopeV3 {
  const shareTarget = target.kind === 'share' ? target.moduleId : null;

  if (shareTarget && carried.quarantined[shareTarget]) {
    // A quarantined blob is by definition one this build could not decode, so it cannot be
    // compacted, validated, or rendered by a viewer — the link would fail on open.
    throw new Error(
      `Module "${shareTarget}" cannot be shared: its data could not be decoded by this build.`
    );
  }

  const modules: Record<string, ModuleBlob> = {};
  for (const codec of registeredCodecs()) {
    if (shareTarget && codec.id !== shareTarget) continue;
    // Quarantined modules have no live slice; their blob is merged back below.
    if (!hasModuleSlice(document, codec)) continue;

    const live = readModule(document, codec);
    const data = shareTarget && codec.compactForShare ? codec.compactForShare(live) : live;

    // Prune on save against a **freshly allocated** baseline. A cached one is reachable from
    // module code through the same reference that was normalized into the document, and a
    // drifted baseline silently drops the slice.
    if (valueEqual(data, codec.defaultData())) continue;
    modules[codec.id] = { v: codec.schemaVersion, data };
  }

  const envelope: DocumentEnvelopeV3 = { version: 3, geometry: document.geometry, modules };
  if (document.space !== undefined) envelope.space = document.space;
  if (document.displayPreferences !== undefined) {
    envelope.displayPreferences = document.displayPreferences;
  }

  if (shareTarget) {
    // A share link is a single-module view: quarantined blobs and all non-target live slices
    // are omitted entirely, or the 8000-character warning threshold does not survive.
    return envelope;
  }

  const drifted = geometryFingerprint(document.geometry) !== carried.geometryFingerprint;
  const flags: Record<string, { geometryChangedSinceLoad: boolean }> = {};
  for (const [id, slice] of Object.entries(carried.quarantined)) {
    if (id in modules) {
      // Decode puts each id in exactly one map, so this is a bug rather than a policy.
      if (import.meta.env.DEV) {
        throw new Error(`Module "${id}" is both live and quarantined; live wins, but fix decode`);
      }
      continue;
    }
    modules[id] = slice.blob as ModuleBlob;
    flags[id] = { geometryChangedSinceLoad: drifted };
  }
  if (Object.keys(flags).length > 0) envelope.quarantineFlags = flags;

  return envelope;
}
