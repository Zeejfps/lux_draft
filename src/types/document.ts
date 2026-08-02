import type { WallSegment, Door, Obstacle } from './geometry';
import type { DisplayPreferences } from './state';
import { defaultModuleSlices } from './moduleRegistry';

export interface WallLoop {
  walls: WallSegment[];
  isClosed: boolean;
}

/** The shared drawing. No module may add a field here. */
export interface FloorplanGeometry {
  boundary: WallLoop;
  doors: Door[];
  obstacles: Obstacle[];
}

/** Room-level facts that are not geometry and not owned by one module. */
export interface SpaceMetadata {
  ceilingHeight: number;
}

/**
 * Per-module document slices.
 *
 * Deliberately opaque: no index signature is exported, so the only doors into it are
 * `readModule` / `withModule` / `buildModuleSlices` in `types/module.ts`.
 */
export type ModuleSlices = Record<never, never>;

/**
 * Editable, undoable, persisted. Nothing else belongs here.
 *
 * Geometry is nested so `boundary: WallLoop` can become `boundaries: WallLoop[]` without
 * rewriting modules — they read through views, not through the document root. Every module's
 * data lives in `modules`; since phase 3b there are no domain fields at the root at all.
 */
export interface EditorDocument {
  geometry: FloorplanGeometry;
  space: SpaceMetadata;
  displayPreferences?: DisplayPreferences;
  /** Opaque; reachable only via readModule / withModule. */
  modules: ModuleSlices;
}

export const DEFAULT_CEILING_HEIGHT = 8.0;

/**
 * Freshly allocated every call — never share a document literal.
 *
 * Module slices are normalized to their defaults exactly as `decodeDocument` does, so a new
 * project and a loaded one are the same shape and a module command works on either.
 */
export function createEmptyDocument(): EditorDocument {
  return {
    geometry: {
      boundary: { walls: [], isClosed: false },
      doors: [],
      obstacles: [],
    },
    space: { ceilingHeight: DEFAULT_CEILING_HEIGHT },
    modules: defaultModuleSlices(),
  };
}
