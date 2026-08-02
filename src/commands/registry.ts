import type { EditorDocument } from '../types/document';
import type { CommandHandler, CommandType, EditorCommand } from '../types/command';
import { isModuleCommand } from '../types/command';
import { moduleCommandHandler } from '../types/moduleRegistry';
import { wallMoveHandler, wallSetLengthHandler, roomCloseHandler } from './wallCommands';
import { vertexMoveHandler, vertexInsertHandler, vertexDeleteHandler } from './vertexCommands';
import { doorAddHandler, doorMoveHandler, doorSetHandler, doorRemoveHandler } from './doorCommands';
import {
  obstacleAddHandler,
  obstacleMoveHandler,
  obstacleVertexMoveHandler,
  obstacleSetHandler,
  obstacleRemoveHandler,
} from './obstacleCommands';
import {
  spaceSetCeilingHeightHandler,
  documentSetDisplayPreferencesHandler,
} from './spaceCommands';
import {
  lightAddHandler,
  lightMoveHandler,
  lightSetHandler,
  lightRemoveHandler,
  lightingSetRafterConfigHandler,
} from './lightCommands';

type HandlerMap = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [K in CommandType]: CommandHandler<any>;
};

const compoundHandler: CommandHandler<Extract<EditorCommand, { type: 'compound' }>> = {
  label: (command) => command.label,
  apply(doc, command) {
    let next = doc;
    for (const inner of command.commands) {
      next = applyCommand(next, inner);
    }
    return next;
  },
};

const handlers: HandlerMap = {
  'wall.move': wallMoveHandler,
  'wall.setLength': wallSetLengthHandler,
  'room.close': roomCloseHandler,
  'vertex.move': vertexMoveHandler,
  'vertex.insert': vertexInsertHandler,
  'vertex.delete': vertexDeleteHandler,
  'door.add': doorAddHandler,
  'door.move': doorMoveHandler,
  'door.set': doorSetHandler,
  'door.remove': doorRemoveHandler,
  'obstacle.add': obstacleAddHandler,
  'obstacle.move': obstacleMoveHandler,
  'obstacle.vertex.move': obstacleVertexMoveHandler,
  'obstacle.set': obstacleSetHandler,
  'obstacle.remove': obstacleRemoveHandler,
  'space.setCeilingHeight': spaceSetCeilingHeightHandler,
  'document.setDisplayPreferences': documentSetDisplayPreferencesHandler,
  'light.add': lightAddHandler,
  'light.move': lightMoveHandler,
  'light.set': lightSetHandler,
  'light.remove': lightRemoveHandler,
  'lighting.setRafterConfig': lightingSetRafterConfigHandler,
  compound: compoundHandler,
};

/** Core command types only. Module command types come from the module registry. */
export const registeredCommandTypes = Object.keys(handlers) as CommandType[];

/**
 * Core handlers are a static table; module handlers come from the registry the eager barrel
 * fills. Handlers stay registered per *installed* module — nothing unregisters `lighting.*`
 * because one document's lighting blob failed to decode.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveHandler(command: EditorCommand): CommandHandler<any> {
  const handler = isModuleCommand(command)
    ? moduleCommandHandler(command.type)
    : handlers[command.type];
  if (!handler) {
    throw new Error(`No handler registered for command type "${command.type}"`);
  }
  return handler;
}

/** Pure. Looks up the handler by `type`. The only document transform in the app. */
export function applyCommand(doc: EditorDocument, command: EditorCommand): EditorDocument {
  return resolveHandler(command).apply(doc, command);
}

/** The user-facing name of the edit. Consumed by history labels since phase 1b. */
export function commandLabel(command: EditorCommand): string {
  return resolveHandler(command).label(command);
}
