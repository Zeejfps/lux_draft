import type { LightDefinition, LightFixture, DeadZoneConfig, SpacingConfig } from './types';
import type { RafterConfig } from './types';
import type { Vector2 } from '../../floorplan/types/geometry';
import type { CommandKind, RegisteredCommand } from '../../floorplan/types/module';
import { defineCommand } from '../../floorplan/types/module';
import type { LightingData } from './codec';
import { lightingCodec, referencedDefinitions } from './codec';

/**
 * Lighting's edits, as registered commands over `LightingData`. **Eager** alongside the codec:
 * a module's edits must be dispatchable before its runtime loads — an undo arriving during a
 * mode switch, a share link opening straight into a document.
 *
 * Phase 3a writes these against the target slice; nothing dispatches them yet. Phase 3b
 * repoints the call sites that today dispatch the legacy root-level `light.*` core commands.
 *
 * The move-and-set family carries absolute targets (`absolute: true`), because those are the
 * commands re-applied to the committed base on every frame of a drag.
 */

export type LightFixtureChanges = Partial<Omit<LightFixture, 'id'>>;

const withFixtures = (prev: Readonly<LightingData>, fixtures: LightFixture[]): LightingData => ({
  ...prev,
  fixtures,
  // The definition closure follows its fixtures: removing the last fixture that referenced a
  // custom definition drops the definition, so prune-on-save can reach the default again.
  definitions: referencedDefinitions(fixtures, prev.definitions),
});

export const addFixture: CommandKind<{ fixture: LightFixture; definition?: LightDefinition }> =
  defineCommand(lightingCodec, 'fixture.add', {
    label: () => 'Add light',
    apply: (_doc, payload, prev) => {
      // A fixture may arrive with a custom definition the document does not carry yet (placed
      // from the picker library). Adopting it here is what keeps the closure closed.
      const definitions = payload.definition
        ? [...prev.definitions.filter((d) => d.id !== payload.definition?.id), payload.definition]
        : prev.definitions;
      return withFixtures({ ...prev, definitions }, [...prev.fixtures, payload.fixture]);
    },
  });

export const moveFixture: CommandKind<{ fixtureId: string; position: Vector2 }> = defineCommand(
  lightingCodec,
  'fixture.move',
  {
    label: () => 'Move light',
    apply: (_doc, payload, prev) => {
      if (!prev.fixtures.some((f) => f.id === payload.fixtureId)) return prev as LightingData;
      return {
        ...prev,
        fixtures: prev.fixtures.map((f) =>
          f.id === payload.fixtureId ? { ...f, position: { ...payload.position } } : f
        ),
      };
    },
  },
  { absolute: true }
);

export const setFixture: CommandKind<{ fixtureId: string; changes: LightFixtureChanges }> =
  defineCommand(
    lightingCodec,
    'fixture.set',
    {
      label: () => 'Change light',
      apply: (_doc, payload, prev) => {
        if (!prev.fixtures.some((f) => f.id === payload.fixtureId)) return prev as LightingData;
        return withFixtures(
          prev,
          prev.fixtures.map((f) => (f.id === payload.fixtureId ? { ...f, ...payload.changes } : f))
        );
      },
    },
    { absolute: true }
  );

export const removeFixture: CommandKind<{ fixtureId: string }> = defineCommand(
  lightingCodec,
  'fixture.remove',
  {
    label: () => 'Delete light',
    apply: (_doc, payload, prev) => {
      const fixtures = prev.fixtures.filter((f) => f.id !== payload.fixtureId);
      return fixtures.length === prev.fixtures.length
        ? (prev as LightingData)
        : withFixtures(prev, fixtures);
    },
  }
);

export const setRafterConfig: CommandKind<{ config: RafterConfig }> = defineCommand(
  lightingCodec,
  'rafters.set',
  {
    label: () => 'Change rafters',
    apply: (_doc, payload, prev) => ({ ...prev, rafterConfig: { ...payload.config } }),
  },
  { absolute: true }
);

export const setDeadZoneConfig: CommandKind<{ config: DeadZoneConfig }> = defineCommand(
  lightingCodec,
  'deadZone.set',
  {
    label: () => 'Change dead-zone settings',
    apply: (_doc, payload, prev) => ({
      ...prev,
      deadZone: { ...payload.config, color: { ...payload.config.color } },
    }),
  },
  { absolute: true }
);

export const setSpacingConfig: CommandKind<{ config: SpacingConfig }> = defineCommand(
  lightingCodec,
  'spacing.set',
  {
    label: () => 'Change spacing settings',
    apply: (_doc, payload, prev) => ({ ...prev, spacing: { ...payload.config } }),
  },
  { absolute: true }
);

/**
 * The explicit adoption step that replaces the old merge-on-decode side effect: incoming
 * definitions become part of the document rather than being silently merged into a global
 * store, and the document's copy of a conflicting id is the one that survives.
 */
export const setDefinitions: CommandKind<{ definitions: LightDefinition[] }> = defineCommand(
  lightingCodec,
  'definitions.set',
  {
    label: () => 'Update light definitions',
    apply: (_doc, payload, prev) => ({
      ...prev,
      definitions: referencedDefinitions(prev.fixtures, payload.definitions),
    }),
  },
  { absolute: true }
);

export const lightingCommands: readonly RegisteredCommand[] = [
  addFixture,
  moveFixture,
  setFixture,
  removeFixture,
  setRafterConfig,
  setDeadZoneConfig,
  setSpacingConfig,
  setDefinitions,
];
