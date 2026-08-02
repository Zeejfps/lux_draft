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
    lights: [],
  };
}
