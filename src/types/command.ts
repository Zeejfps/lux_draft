import type { Vector2, WallSegment, Door, Obstacle } from './geometry';
import type { DisplayPreferences } from './state';
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
 * `obstacle.vertex.move`, `obstacle.set`, `space.setCeilingHeight`,
 * `document.setDisplayPreferences`, and every module command declared `absolute`.
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
  // --- composition --------------------------------------------------------
  /** One user intent, several entities. Applied in order; still one history entry. */
  | { type: 'compound'; label: string; commands: EditorCommand[] };

export type DoorChanges = Partial<Omit<Door, 'id'>>;
export type ObstacleChanges = Partial<Omit<Obstacle, 'id' | 'walls'>>;

/**
 * A module's command. Modules contribute their own; the core never names them.
 *
 * Built only by `defineCommand` (`src/types/module.ts`), which owns the `${moduleId}.${verb}`
 * string and generates the handler, so a producer and its handler cannot drift apart.
 */
export interface ModuleCommandEnvelope {
  /** `${moduleId}.${verb}`. */
  type: string;
  moduleId: string;
  payload: unknown;
}

export type EditorCommand = CoreCommand | ModuleCommandEnvelope;

/**
 * Core command types only. Module command types are strings the core never enumerates, so the
 * exhaustive core handler table and the tests that iterate it keep working unchanged.
 */
export type CommandType = CoreCommand['type'];

/** `moduleId` is the discriminator: no core command has one. */
export function isModuleCommand(command: EditorCommand): command is ModuleCommandEnvelope {
  return 'moduleId' in command;
}

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
  'space.setCeilingHeight',
  'document.setDisplayPreferences',
];
