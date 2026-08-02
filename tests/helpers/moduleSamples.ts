import type { EditorDocument } from '../../src/types/document';
import type { ModuleCodec } from '../../src/types/module';
import { buildModuleSlices } from '../../src/types/module';
import { createEmptyDocument } from '../../src/types/document';
import * as lighting from '../../src/modules/lighting/commands';

/**
 * Sample payloads for the shared command contract test.
 *
 * Keyed by command type, and the contract test fails if a registered module command has no
 * entry — so adding a command forces a sample, which is what keeps the serializability and
 * idempotence assertions honest as modules grow.
 */
export const COMMAND_SAMPLES: Record<string, unknown> = {
  [lighting.addFixture.type]: {
    fixture: {
      id: 'sample-fixture',
      position: { x: 1, y: 2 },
      definitionId: 'custom-sample',
      properties: { lumen: 900, beamAngle: 45, warmth: 3000 },
    },
    definition: {
      id: 'custom-sample',
      name: 'Sample',
      lumen: 900,
      beamAngle: 45,
      warmth: 3000,
    },
  },
  [lighting.moveFixture.type]: { fixtureId: 'sample-fixture', position: { x: 4, y: 5 } },
  [lighting.setFixture.type]: {
    fixtureId: 'sample-fixture',
    changes: { properties: { lumen: 1200, beamAngle: 60, warmth: 2700 } },
  },
  [lighting.removeFixture.type]: { fixtureId: 'sample-fixture' },
  [lighting.setRafterConfig.type]: {
    config: { orientation: 'vertical', spacing: 2, offsetX: 0, offsetY: 0, visible: true },
  },
  [lighting.setDeadZoneConfig.type]: {
    config: { enabled: true, threshold: 8, color: { r: 1, g: 0, b: 0 }, opacity: 0.5 },
  },
  [lighting.setSpacingConfig.type]: {
    config: { enabled: true, overlapFactor: 0.8, gapTolerance: 0.2 },
  },
  [lighting.setDefinitions.type]: {
    definitions: [{ id: 'custom-sample', name: 'Sample', lumen: 900, beamAngle: 45, warmth: 3000 }],
  },
};

/** A document carrying one live module slice and nothing else. */
export function documentWithSlice<T>(codec: ModuleCodec<T>, data: T): EditorDocument {
  return { ...createEmptyDocument(), modules: buildModuleSlices({ [codec.id]: data }) };
}
