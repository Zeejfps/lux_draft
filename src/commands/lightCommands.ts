import type { CommandHandler, CoreCommand } from '../types/command';

/**
 * Legacy lighting commands. Lighting data still lives at the document root in phase 1a;
 * phase 3b re-registers these as `lighting.*` module commands over `LightingData`.
 */

type LightAdd = Extract<CoreCommand, { type: 'light.add' }>;
type LightMove = Extract<CoreCommand, { type: 'light.move' }>;
type LightSet = Extract<CoreCommand, { type: 'light.set' }>;
type LightRemove = Extract<CoreCommand, { type: 'light.remove' }>;
type SetRafterConfig = Extract<CoreCommand, { type: 'lighting.setRafterConfig' }>;

export const lightAddHandler: CommandHandler<LightAdd> = {
  label: () => 'Add light',
  apply(doc, command) {
    return { ...doc, lights: [...doc.lights, command.light] };
  },
};

export const lightMoveHandler: CommandHandler<LightMove> = {
  label: () => 'Move light',
  apply(doc, command) {
    if (!doc.lights.some((l) => l.id === command.lightId)) return doc;
    return {
      ...doc,
      lights: doc.lights.map((l) =>
        l.id === command.lightId ? { ...l, position: { ...command.position } } : l
      ),
    };
  },
};

export const lightSetHandler: CommandHandler<LightSet> = {
  label: () => 'Change light',
  apply(doc, command) {
    if (!doc.lights.some((l) => l.id === command.lightId)) return doc;
    return {
      ...doc,
      lights: doc.lights.map((l) => (l.id === command.lightId ? { ...l, ...command.changes } : l)),
    };
  },
};

export const lightRemoveHandler: CommandHandler<LightRemove> = {
  label: () => 'Delete light',
  apply(doc, command) {
    const lights = doc.lights.filter((l) => l.id !== command.lightId);
    return lights.length === doc.lights.length ? doc : { ...doc, lights };
  },
};

export const lightingSetRafterConfigHandler: CommandHandler<SetRafterConfig> = {
  label: () => 'Change rafters',
  apply(doc, command) {
    return { ...doc, rafterConfig: command.config };
  },
};
