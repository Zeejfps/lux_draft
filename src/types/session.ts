import type { EditorDocument } from './document';
import type { Interaction } from './interaction';
import type { Selection } from './selection';
import { createEmptyDocument } from './document';
import { IDLE_INTERACTION } from './interaction';
import { NO_SELECTION } from './selection';

// ============================================
// Carried state (persisted, never edited)
// ============================================

/**
 * A module blob this build could not decode. Carried from load to save so unknown or newer
 * data is never silently dropped.
 *
 * Phase 3a fills this in; phase 1b only gives it a home on `Session` so no later phase has to
 * thread a new field through the reducer.
 */
export interface QuarantinedSlice {
  blob: { v: number; data: unknown };
  reason: 'unsupported' | 'invalid' | 'unknownModule';
  message?: string;
}

export interface CarriedState {
  quarantined: Readonly<Record<string, QuarantinedSlice>>;
  /** Structural hash of geometry at load time; drives the staleness flag. Computed in 3a. */
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

/** Wrap a bare document as a load result. Phase 3b replaces every call with a real decode. */
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
