import type { WallSegment, Door, Obstacle } from './geometry';
import type { LightFixture } from './lighting';
import type { DisplayPreferences, RafterConfig } from './state';

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
 * `readModule` / `withModule`, which phase 3a adds. Phase 1b starts it as an empty map so no
 * later phase has to thread a new document field through the reducer and every codec.
 */
export type ModuleSlices = Record<never, never>;

/**
 * Editable, undoable, persisted. Nothing else belongs here.
 *
 * Phase 1a shape: `geometry` and `space` are nested as in the target model, but the lighting
 * fields (`lights`, `rafterConfig`) still sit at the document root. Phase 3b moves them into
 * `modules.lighting` and deletes them from here.
 */
export interface EditorDocument {
  geometry: FloorplanGeometry;
  space: SpaceMetadata;
  displayPreferences?: DisplayPreferences;
  /** Opaque; reachable only via readModule / withModule (phase 3a). Empty until phase 3b. */
  modules: ModuleSlices;
  /** LEGACY (phase 3b moves this into `modules.lighting`). */
  lights: LightFixture[];
  /** LEGACY (phase 3b moves this into `modules.lighting`). */
  rafterConfig?: RafterConfig;
}

export const DEFAULT_CEILING_HEIGHT = 8.0;

/** Freshly allocated every call — never share a document literal. */
export function createEmptyDocument(): EditorDocument {
  return {
    geometry: {
      boundary: { walls: [], isClosed: false },
      doors: [],
      obstacles: [],
    },
    space: { ceilingHeight: DEFAULT_CEILING_HEIGHT },
    modules: {},
    lights: [],
  };
}
