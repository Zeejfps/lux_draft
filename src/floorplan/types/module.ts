import type { EditorDocument, ModuleSlices } from './document';
import type { CommandHandler, EditorCommand, ModuleCommandEnvelope } from './command';
import type { DeepReadonly } from './deepReadonly';
import type { Session } from './session';
import { assertPlainData } from '../commands/serializable';
import { deepFreeze } from '../utils/deepFreeze';

/**
 * The module data contract. Core owns this file and it names no module (invariant 6/7).
 *
 * Codecs load **eagerly** — `decodeDocument` is synchronous and must be able to read every
 * installed module's slice before any runtime has been imported. The lint rules from phase 0
 * keep `three`, `*.svelte`, and `runtime.ts` out of the files that implement this interface.
 */

// ============================================
// Blobs and decode results
// ============================================

/** The on-disk form of one module's slice. `v` is the module's own schema version. */
export interface ModuleBlob {
  v: number;
  data: unknown;
}

export type DecodeResult<T> =
  | { status: 'ok'; data: T }
  | { status: 'unsupported'; writtenVersion: number; message: string }
  | { status: 'invalid'; message: string };

export interface ModuleCodec<T> {
  readonly id: string;
  readonly schemaVersion: number;
  /**
   * A fresh slice for a document that has none. Cheap, pure, and **freshly allocated** on
   * every call: prune-on-save compares against this value, and a shared object would drift
   * the baseline and silently drop the slice. Asserted by the shared codec contract test.
   */
  defaultData(): T;
  /** Never throws — returns a status. Hostile input is the normal case. */
  decode(blob: ModuleBlob): DecodeResult<T>;
  /**
   * Strip non-essential fields for share URLs. Defaults to identity.
   *
   * Returns `T`, not `unknown`, and that is load-bearing: a compacted payload is written at
   * the current `schemaVersion` and read back by the ordinary decoder, so a free-form return
   * could produce a link this module's own `decode` rejects — a bug that would surface as
   * quarantined data on the recipient's machine rather than on the sender's.
   */
  compactForShare?(data: Readonly<T>): T;
}

// ============================================
// The only doors into ModuleSlices
// ============================================

/**
 * `ModuleSlices` is opaque — `Record<never, never>`, no index signature is exported — so the
 * functions below are the only way in. The codec is the key, so a call site gets `LightingData`
 * rather than `unknown` and the id string is written exactly once.
 */
function slicesOf(doc: DeepReadonly<EditorDocument>): Readonly<Record<string, unknown>> {
  return doc.modules as Readonly<Record<string, unknown>>;
}

/** True when this document carries live data for the module (false when it is quarantined). */
export function hasModuleSlice(
  doc: DeepReadonly<EditorDocument>,
  codec: ModuleCodec<unknown>
): boolean {
  return codec.id in slicesOf(doc);
}

/**
 * A module's slice. Falls back to a freshly allocated default when the slice is absent, which
 * happens only for a quarantined module or a hand-built document — `decodeDocument` normalizes
 * a default into every live slice, so an ordinary read is an ordinary field read.
 */
export function readModule<T>(
  doc: DeepReadonly<EditorDocument>,
  codec: ModuleCodec<T>
): Readonly<T> {
  const slice = slicesOf(doc)[codec.id];
  return slice === undefined ? codec.defaultData() : (slice as Readonly<T>);
}

/**
 * Replace a module's slice. Pure, and takes no store, so it cannot become a second write path:
 * its result reaches the session only by being returned from a command handler.
 *
 * A module whose slice is quarantined has no slice to target, so this is a no-op — the
 * document is returned by reference and the dispatch produces no history entry. No UI path can
 * produce one, because a quarantined module's mode is not selectable.
 */
export function withModule<T>(
  doc: DeepReadonly<EditorDocument>,
  codec: ModuleCodec<T>,
  fn: (prev: Readonly<T>) => T
): EditorDocument {
  const document = doc as EditorDocument;
  if (!hasModuleSlice(doc, codec)) {
    if (import.meta.env.DEV) {
      console.warn(
        `withModule("${codec.id}") on a document with no such slice — the module's data is ` +
          'quarantined or the document was not built by decodeDocument. Ignored.'
      );
    }
    return document;
  }
  const next = fn(readModule(doc, codec));
  if (import.meta.env.DEV) {
    // A slice is persisted verbatim, so a `Map`, a class instance, or a `NaN` reaching one is a
    // document that saves as `{}` and reloads empty. Assert at the write, not at the save.
    assertPlainData(next, `modules.${codec.id}`);
    deepFreeze(next);
  }
  return { ...document, modules: buildModuleSlices({ ...slicesOf(doc), [codec.id]: next }) };
}

/** Build the opaque map from a plain record. The one constructor; used by `decodeDocument`. */
export function buildModuleSlices(entries: Readonly<Record<string, unknown>>): ModuleSlices {
  return { ...entries } as ModuleSlices;
}

/** Every live slice id on this document, for encode and for diagnostics. */
export function moduleSliceIds(doc: DeepReadonly<EditorDocument>): string[] {
  return Object.keys(slicesOf(doc));
}

// ============================================
// Data status (derived, never stored)
// ============================================

/**
 * An id is `live` iff it is in `document.modules` and `quarantined` iff it is in
 * `carried.quarantined`. Decode guarantees exactly one of the two, asserted in dev, which is
 * why the reason lives beside the blob rather than only in `Diagnostics.warnings` — the
 * warnings are a user-facing presentation of this classification, not a second source of truth.
 */
export type ModuleDataStatus =
  | { kind: 'live' }
  | { kind: 'quarantined'; reason: QuarantineReason; message?: string };

export type QuarantineReason = 'unsupported' | 'invalid' | 'unknownModule';

export function moduleDataStatus(session: Session, moduleId: string): ModuleDataStatus {
  const slice = session.carried.quarantined[moduleId];
  if (slice) return { kind: 'quarantined', reason: slice.reason, message: slice.message };
  return { kind: 'live' };
}

// ============================================
// defineCommand
// ============================================

/**
 * A module command type. Owns the module id and verb strings so a producer and its handler
 * cannot drift, exactly as `defineSelection` does for selections.
 *
 * `RegisteredCommand` is the erased form the registry stores: `CommandKind<P>` is invariant in
 * `P` (`make` takes it, `match` returns it), so a heterogeneous list of them needs the payload
 * type gone rather than widened to `unknown`.
 */
export interface RegisteredCommand {
  readonly type: string;
  readonly moduleId: string;
  readonly verb: string;
  /** Member of the move-and-set family: absolute payload, so applying twice equals once. */
  readonly absolute: boolean;
  readonly handler: CommandHandler<ModuleCommandEnvelope>;
}

export interface CommandKind<P> extends RegisteredCommand {
  make(payload: P): ModuleCommandEnvelope;
  /** The payload if this command is one of these, else null. */
  match(command: EditorCommand): P | null;
}

export interface ModuleCommandSpec<T, P> {
  label(payload: P): string;
  apply(doc: DeepReadonly<EditorDocument>, payload: P, prev: Readonly<T>): T;
}

/**
 * Owns the module id and verb strings; wraps the handler in `withModule`.
 *
 * The common case — a command touching one module's slice — never sees the whole document,
 * though `apply` still receives it read-only for the handler that must consult geometry.
 */
export function defineCommand<T, P>(
  codec: ModuleCodec<T>,
  verb: string,
  spec: ModuleCommandSpec<T, P>,
  options: { absolute?: boolean } = {}
): CommandKind<P> {
  const type = `${codec.id}.${verb}`;
  const handler: CommandHandler<ModuleCommandEnvelope> = {
    label: (command) => spec.label(command.payload as P),
    apply: (doc, command) =>
      withModule(doc, codec, (prev) => spec.apply(doc, command.payload as P, prev)),
  };
  return {
    type,
    moduleId: codec.id,
    verb,
    absolute: options.absolute ?? false,
    handler,
    make: (payload) => ({ type, moduleId: codec.id, payload }),
    match: (command) =>
      'moduleId' in command && command.type === type ? (command.payload as P) : null,
  };
}
