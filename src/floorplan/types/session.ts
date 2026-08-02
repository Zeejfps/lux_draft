import type { EditorDocument } from './document';
import type { Interaction } from './interaction';
import type { ModuleBlob, QuarantineReason } from './module';
import type { Selection } from './selection';
import { createEmptyDocument } from './document';
import { IDLE_INTERACTION } from './interaction';
import { NO_SELECTION } from './selection';

// ============================================
// Carried state (persisted, never edited)
// ============================================

/**
 * A module blob this build could not decode. Carried from load to save so unknown or newer
 * data is never silently dropped (invariant 8), and never edited or rendered.
 */
export interface QuarantinedSlice {
  blob: ModuleBlob;
  reason: QuarantineReason;
  message?: string;
}

export interface CarriedState {
  quarantined: Readonly<Record<string, QuarantinedSlice>>;
  /**
   * Structural hash of geometry at load time. If it no longer matches at save, the envelope
   * records `geometryChangedSinceLoad` beside every quarantined blob — a preserved blob may
   * have been authored for a different polygon.
   */
  geometryFingerprint: string;
}

export function createEmptyCarriedState(): CarriedState {
  return { quarantined: {}, geometryFingerprint: '' };
}

// ============================================
// Diagnostics (session-scoped, not persisted, not undoable)
// ============================================

export type ModuleRuntimeStatus =
  | { kind: 'inactive' }
  | { kind: 'loading' }
  | { kind: 'active' }
  | { kind: 'failed'; message: string };

export interface DocumentWarning {
  moduleId?: string;
  message: string;
}

export interface Diagnostics {
  warnings: DocumentWarning[];
  runtimeStatus: Readonly<Record<string, ModuleRuntimeStatus>>;
}

export function createEmptyDiagnostics(): Diagnostics {
  return { warnings: [], runtimeStatus: {} };
}

// ============================================
// History
// ============================================

export interface HistoryEntry {
  document: EditorDocument;
  /** Names the action that changed the document away from this snapshot. */
  label: string;
}

export interface History {
  readonly past: readonly HistoryEntry[];
  readonly future: readonly HistoryEntry[];
}

export const EMPTY_HISTORY: History = { past: [], future: [] };

/** The label of the edit that `undo` would reverse, or null when there is nothing to undo. */
export function undoLabel(h: History): string | null {
  return h.past.at(-1)?.label ?? null;
}

/** The label of the edit that `redo` would re-apply, or null when there is nothing to redo. */
export function redoLabel(h: History): string | null {
  return h.future[0]?.label ?? null;
}

export function canUndo(h: History): boolean {
  return h.past.length > 0;
}

export function canRedo(h: History): boolean {
  return h.future.length > 0;
}

// ============================================
// Session
// ============================================

/**
 * The one session value (invariant 1). It owns the committed document, carried quarantine
 * data, ephemeral interaction and selection state, session diagnostics, and snapshot history:
 * data lifetime is a position in a type rather than a convention.
 *
 * `reduceSession` is the sole constructor of these values.
 */
export interface Session {
  readonly document: EditorDocument;
  readonly carried: CarriedState;
  readonly selection: Selection;
  readonly interaction: Interaction;
  readonly diagnostics: Diagnostics;
  readonly history: History;
}

/** What `documentCodec.decodeDocument` will return in phase 3a. */
export interface LoadedDocument {
  document: EditorDocument;
  carried: CarriedState;
  diagnostics: Diagnostics;
}

/**
 * What every save path needs: the committed document plus the carried quarantine state.
 *
 * `encodeDocument` takes `carried` as a required positional parameter, so threading the two
 * together is what makes "forgot the quarantined blobs" a compile error rather than silent
 * data loss on the next save.
 */
export interface SaveInput {
  document: EditorDocument;
  carried: CarriedState;
}

/** Wrap a bare document as a load result — a new project, not a decoded one. */
export function asLoadedDocument(document: EditorDocument): LoadedDocument {
  return {
    document,
    carried: createEmptyCarriedState(),
    diagnostics: createEmptyDiagnostics(),
  };
}

export function createEmptySession(): Session {
  return {
    document: createEmptyDocument(),
    carried: createEmptyCarriedState(),
    selection: NO_SELECTION,
    interaction: IDLE_INTERACTION,
    diagnostics: createEmptyDiagnostics(),
    history: EMPTY_HISTORY,
  };
}
