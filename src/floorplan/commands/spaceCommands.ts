import type { CommandHandler, CoreCommand } from '../types/command';

type SetCeilingHeight = Extract<CoreCommand, { type: 'space.setCeilingHeight' }>;
type SetDisplayPreferences = Extract<CoreCommand, { type: 'document.setDisplayPreferences' }>;

export const spaceSetCeilingHeightHandler: CommandHandler<SetCeilingHeight> = {
  label: () => 'Change ceiling height',
  apply(doc, command) {
    if (doc.space.ceilingHeight === command.height) return doc;
    return { ...doc, space: { ...doc.space, ceilingHeight: command.height } };
  },
};

export const documentSetDisplayPreferencesHandler: CommandHandler<SetDisplayPreferences> = {
  label: () => 'Change display preferences',
  apply(doc, command) {
    return { ...doc, displayPreferences: command.preferences };
  },
};
