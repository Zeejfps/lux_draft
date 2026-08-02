import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import {
  addLight,
  applyDefinitionToFixtures,
  committedLightingData,
  deadZoneConfig,
  fixtures,
  lightingData,
  moveLight,
  pickerDefinitions,
  rafterConfig,
  removeLights,
  spacingConfig,
  toggleDeadZones,
  toggleRafters,
  toggleSpacingWarnings,
} from '../../../src/modules/lighting/store';
import { lightDefinitions } from '../../../src/modules/lighting/definitionsStore';
import { sessionStore } from '../../../src/floorplan/stores/sessionStore';
import { openDocument } from '../../../src/floorplan/stores/roomStore';
import { moveFixture } from '../../../src/modules/lighting/commands';
import { lightingCodec } from '../../../src/modules/lighting/codec';
import { DEFAULT_LIGHT_DEFINITIONS } from '../../../src/modules/lighting/types';
import { DEFAULT_RAFTER_CONFIG } from '../../../src/modules/lighting/types';
import { makeLight, squareRoom } from '../../helpers/documents';

/**
 * Lighting's read and write layer. Everything it exposes is a projection of the one session
 * value, and everything it writes is one registered `lighting.*` command — so an edit is
 * undoable, a read is an ordinary field read, and no store holds a second copy.
 */
beforeEach(() => {
  lightDefinitions.set([...DEFAULT_LIGHT_DEFINITIONS]);
  openDocument(squareRoom());
});

describe('projections', () => {
  it('a new document already carries a materialized default slice', () => {
    expect(get(fixtures)).toEqual([]);
    expect(get(rafterConfig)).toEqual(DEFAULT_RAFTER_CONFIG);
    expect(get(deadZoneConfig)).toEqual(lightingCodec.defaultData().deadZone);
    expect(get(spacingConfig)).toEqual(lightingCodec.defaultData().spacing);
  });

  it('do not emit when an unrelated part of the document changes', () => {
    let emissions = -1;
    const stop = fixtures.subscribe(() => {
      emissions++;
    });
    sessionStore.dispatch({ type: 'space.setCeilingHeight', height: 11 });
    stop();

    expect(emissions).toBe(0);
  });

  it('the live view shows a candidate command; the committed view does not', () => {
    addLight(makeLight('l1', { x: 5, y: 5 }));

    sessionStore.setInteraction({
      kind: 'commandPreview',
      command: moveFixture.make({ fixtureId: 'l1', position: { x: 7, y: 7 } }),
    });

    expect(get(lightingData).fixtures[0].position).toEqual({ x: 7, y: 7 });
    expect(get(committedLightingData).fixtures[0].position).toEqual({ x: 5, y: 5 });

    sessionStore.cancelInteraction();
    expect(get(lightingData).fixtures[0].position).toEqual({ x: 5, y: 5 });
  });
});

describe('writes', () => {
  it('each setter is one undoable command', () => {
    toggleRafters();
    expect(get(rafterConfig).visible).toBe(!DEFAULT_RAFTER_CONFIG.visible);
    sessionStore.undo();
    expect(get(rafterConfig).visible).toBe(DEFAULT_RAFTER_CONFIG.visible);

    toggleDeadZones();
    expect(get(deadZoneConfig).enabled).toBe(!lightingCodec.defaultData().deadZone.enabled);

    toggleSpacingWarnings();
    expect(get(spacingConfig).enabled).toBe(!lightingCodec.defaultData().spacing.enabled);
  });

  it('add, move and remove fixtures', () => {
    addLight(makeLight('l1', { x: 1, y: 1 }));
    addLight(makeLight('l2', { x: 2, y: 2 }));
    expect(get(fixtures).map((f) => f.id)).toEqual(['l1', 'l2']);

    moveLight('l1', { x: 9, y: 9 });
    expect(get(fixtures)[0].position).toEqual({ x: 9, y: 9 });

    removeLights(['l1', 'l2']);
    expect(get(fixtures)).toEqual([]);
  });

  it('deleting several fixtures is one history entry', () => {
    addLight(makeLight('l1', { x: 1, y: 1 }));
    addLight(makeLight('l2', { x: 2, y: 2 }));

    removeLights(['l1', 'l2']);
    sessionStore.undo();

    expect(get(fixtures).map((f) => f.id)).toEqual(['l1', 'l2']);
  });

  it('removing nothing dispatches nothing', () => {
    const before = get(committedLightingData);
    removeLights([]);
    expect(get(committedLightingData)).toBe(before);
  });
});

describe('definitions belong to the document', () => {
  const custom = {
    id: 'custom-99',
    name: 'Imported can',
    lumen: 1500,
    beamAngle: 40,
    warmth: 3500,
  };

  it('placing a fixture from the picker adopts its custom definition into the closure', () => {
    addLight({ ...makeLight('l1', { x: 1, y: 1 }), definitionId: custom.id }, custom);

    expect(get(committedLightingData).definitions).toEqual([custom]);
  });

  it('the closure follows its fixtures — the last reference leaving drops it', () => {
    addLight({ ...makeLight('l1', { x: 1, y: 1 }), definitionId: custom.id }, custom);
    removeLights(['l1']);

    expect(get(committedLightingData).definitions).toEqual([]);
  });

  it('re-pointing fixtures at a custom definition adopts it in the same command', () => {
    addLight(makeLight('l1', { x: 1, y: 1 }));

    applyDefinitionToFixtures(['l1'], custom);

    expect(get(fixtures)[0].definitionId).toBe(custom.id);
    expect(get(fixtures)[0].properties.lumen).toBe(custom.lumen);
    expect(get(committedLightingData).definitions).toEqual([custom]);

    // One history entry, not two.
    sessionStore.undo();
    expect(get(fixtures)[0].definitionId).toBeUndefined();
    expect(get(committedLightingData).definitions).toEqual([]);
  });

  it('a builtin definition is never written into the closure', () => {
    addLight(makeLight('l1', { x: 1, y: 1 }));
    applyDefinitionToFixtures(['l1'], DEFAULT_LIGHT_DEFINITIONS[0]);

    expect(get(committedLightingData).definitions).toEqual([]);
  });

  it('the picker offers the document copy of a conflicting id, not the local one', () => {
    lightDefinitions.set([...DEFAULT_LIGHT_DEFINITIONS, { ...custom, name: 'Mine', lumen: 100 }]);
    addLight({ ...makeLight('l1', { x: 1, y: 1 }), definitionId: custom.id }, custom);

    const offered = get(pickerDefinitions).find((d) => d.id === custom.id);
    expect(offered).toEqual(custom);
  });
});
