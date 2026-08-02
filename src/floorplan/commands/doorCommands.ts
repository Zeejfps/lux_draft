import type { CommandHandler, CoreCommand } from '../types/command';
import { withDoors } from './documentEdits';

type DoorAdd = Extract<CoreCommand, { type: 'door.add' }>;
type DoorMove = Extract<CoreCommand, { type: 'door.move' }>;
type DoorSet = Extract<CoreCommand, { type: 'door.set' }>;
type DoorRemove = Extract<CoreCommand, { type: 'door.remove' }>;

export const doorAddHandler: CommandHandler<DoorAdd> = {
  label: () => 'Add door',
  apply(doc, command) {
    return withDoors(doc, [...doc.geometry.doors, command.door]);
  },
};

export const doorMoveHandler: CommandHandler<DoorMove> = {
  label: () => 'Move door',
  apply(doc, command) {
    const doors = doc.geometry.doors;
    if (!doors.some((d) => d.id === command.doorId)) return doc;
    return withDoors(
      doc,
      doors.map((d) => (d.id === command.doorId ? { ...d, position: command.offset } : d))
    );
  },
};

export const doorSetHandler: CommandHandler<DoorSet> = {
  label: () => 'Change door',
  apply(doc, command) {
    const doors = doc.geometry.doors;
    if (!doors.some((d) => d.id === command.doorId)) return doc;
    return withDoors(
      doc,
      doors.map((d) => (d.id === command.doorId ? { ...d, ...command.changes } : d))
    );
  },
};

export const doorRemoveHandler: CommandHandler<DoorRemove> = {
  label: () => 'Delete door',
  apply(doc, command) {
    const doors = doc.geometry.doors.filter((d) => d.id !== command.doorId);
    return doors.length === doc.geometry.doors.length ? doc : withDoors(doc, doors);
  },
};
