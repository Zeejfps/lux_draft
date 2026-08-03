import type { EditorDocument } from '../../src/floorplan/types/document';
import type { ModuleCodec } from '../../src/floorplan/types/module';
import { buildModuleSlices } from '../../src/floorplan/types/module';
import { createEmptyDocument } from '../../src/floorplan/types/document';
import * as lighting from '../../src/modules/lighting/commands';
import * as flooring from '../../src/modules/flooring/commands';

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
  [flooring.configureLayout.type]: {
    config: {
      runAngleDeg: 45,
      startCorner: 'topRight',
      stagger: 'random',
      minEndCutIn: 6,
      expansionGapIn: 0.5,
      rowOffsetPattern: [0, 0.25, 0.5, 0.75],
      seed: 7,
    },
  },
  [flooring.setPlankSpec.type]: {
    plank: { widthIn: 6, lengthIn: 36, name: 'Sample plank', minRipWidthIn: 2 },
  },
  [flooring.moveOrigin.type]: { position: { x: 2, y: 3 } },
  [flooring.addTransition.type]: {
    transition: { id: 'sample-transition', doorId: 'sample-door', kind: 'reducer' },
  },
  [flooring.removeTransition.type]: { transitionId: 'sample-transition' },
  [flooring.addDivider.type]: {
    divider: {
      id: 'sample-divider',
      a: { x: 0, y: 4 },
      b: { x: 10, y: 4 },
      kind: 'tMolding',
    },
  },
  [flooring.setDividerKind.type]: { dividerId: 'sample-divider', kind: 'reducer' },
  [flooring.removeDivider.type]: { dividerId: 'sample-divider' },
  [flooring.setSurfaces.type]: {
    surfaces: [
      { seed: { x: 5, y: 2 }, surface: 'plank' },
      { seed: { x: 5, y: 8 }, surface: 'carpet' },
    ],
  },
};

/** A document carrying one live module slice and nothing else. */
export function documentWithSlice<T>(codec: ModuleCodec<T>, data: T): EditorDocument {
  return { ...createEmptyDocument(), modules: buildModuleSlices({ [codec.id]: data }) };
}
