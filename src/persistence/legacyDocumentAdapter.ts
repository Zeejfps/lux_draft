import type { RoomState } from '../types/state';
import type { EditorDocument } from '../types/document';

/**
 * THE flat-shape adapter.
 *
 * Persistence (local storage, JSON import/export, share URLs) still reads and writes the flat
 * legacy `RoomState` shape in phase 1a. Everything above persistence speaks `EditorDocument`.
 * Phase 3b routes every entry point through `documentCodec` and **deletes this file**; nothing
 * else may translate between the two shapes.
 */

export function toLegacyRoomState(doc: EditorDocument): RoomState {
  const state: RoomState = {
    ceilingHeight: doc.space.ceilingHeight,
    walls: doc.geometry.boundary.walls,
    lights: doc.lights,
    doors: doc.geometry.doors,
    obstacles: doc.geometry.obstacles,
    isClosed: doc.geometry.boundary.isClosed,
  };
  if (doc.rafterConfig !== undefined) state.rafterConfig = doc.rafterConfig;
  if (doc.displayPreferences !== undefined) state.displayPreferences = doc.displayPreferences;
  return state;
}

export function fromLegacyRoomState(state: RoomState): EditorDocument {
  const doc: EditorDocument = {
    geometry: {
      boundary: { walls: state.walls ?? [], isClosed: state.isClosed },
      doors: state.doors ?? [],
      obstacles: state.obstacles ?? [],
    },
    space: { ceilingHeight: state.ceilingHeight },
    lights: state.lights ?? [],
  };
  if (state.rafterConfig !== undefined) doc.rafterConfig = state.rafterConfig;
  if (state.displayPreferences !== undefined) doc.displayPreferences = state.displayPreferences;
  return doc;
}
