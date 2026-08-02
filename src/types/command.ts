import type { Vector2, WallSegment, Door, Obstacle } from './geometry';
import type { LightFixture } from './lighting';
import type { DisplayPreferences, RafterConfig } from './state';
import type { EditorDocument } from './document';

/**
 * Commands are the only way to edit a document (invariant 2).
 *
 * They are serializable data — no functions, no Maps, no Sets, no class instances — and their
 * handlers are pure `(document, command) => document`.
 *
 * The **move and set family** carries absolute targets, never deltas, because those are the
 * commands re-applied to the committed base on every frame of a drag: `wall.move`,
 * `wall.setLength`, `vertex.move`, `door.move`, `door.set`, `obstacle.move`,
 * `obstacle.vertex.move`, `obstacle.set`, `light.move`, `light.set`,
 * `space.setCeilingHeight`, `document.setDisplayPreferences`, `lighting.setRafterConfig`.
 * Applying one of those twice equals applying it once.
 *
 * `*.add`, `vertex.insert`, and `*.remove` are produced by discrete clicks, are never previewed
 * per frame, and are deliberately not idempotent.
 */
export type CoreCommand =
  // --- boundary -----------------------------------------------------------
  | { type: 'wall.move'; wallId: string; start: Vector2; end: Vector2 }
  | { type: 'wall.setLength'; wallId: string; length: number }
  | { type: 'vertex.move'; index: number; position: Vector2 }
  | { type: 'vertex.insert'; wallId: string; position: Vector2 }
  | { type: 'vertex.delete'; index: number }
  | { type: 'room.close'; walls: WallSegment[] }
  // --- doors --------------------------------------------------------------
  | { type: 'door.add'; door: Door }
  | { type: 'door.move'; doorId: string; offset: number }
  | { type: 'door.set'; doorId: string; changes: DoorChanges }
  | { type: 'door.remove'; doorId: string }
  // --- obstacles ----------------------------------------------------------
  | { type: 'obstacle.add'; obstacle: Obstacle }
  | { type: 'obstacle.move'; obstacleId: string; vertices: Vector2[] }
  | { type: 'obstacle.vertex.move'; obstacleId: string; index: number; position: Vector2 }
  | { type: 'obstacle.set'; obstacleId: string; changes: ObstacleChanges }
  | { type: 'obstacle.remove'; obstacleId: string }
  // --- space / document ---------------------------------------------------
  | { type: 'space.setCeilingHeight'; height: number }
  | { type: 'document.setDisplayPreferences'; preferences: DisplayPreferences }
  // --- lighting (legacy; becomes `lighting.*` module commands in phase 3b) --
  | { type: 'light.add'; light: LightFixture }
  | { type: 'light.move'; lightId: string; position: Vector2 }
  | { type: 'light.set'; lightId: string; changes: LightChanges }
  | { type: 'light.remove'; lightId: string }
  | { type: 'lighting.setRafterConfig'; config: RafterConfig }
  // --- composition --------------------------------------------------------
  /** One user intent, several entities. Applied in order; still one history entry. */
  | { type: 'compound'; label: string; commands: EditorCommand[] };

export type DoorChanges = Partial<Omit<Door, 'id'>>;
export type ObstacleChanges = Partial<Omit<Obstacle, 'id' | 'walls'>>;
export type LightChanges = Partial<Omit<LightFixture, 'id'>>;

export type EditorCommand = CoreCommand;

export type CommandType = EditorCommand['type'];

export interface CommandHandler<C extends EditorCommand> {
  label(command: C): string;
  apply(doc: EditorDocument, command: C): EditorDocument;
}

/** The set of command types whose payloads must be absolute, and so idempotent. */
export const MOVE_AND_SET_COMMAND_TYPES: readonly CommandType[] = [
  'wall.move',
  'wall.setLength',
  'vertex.move',
  'door.move',
  'door.set',
  'obstacle.move',
  'obstacle.vertex.move',
  'obstacle.set',
  'light.move',
  'light.set',
  'space.setCeilingHeight',
  'document.setDisplayPreferences',
  'lighting.setRafterConfig',
];
