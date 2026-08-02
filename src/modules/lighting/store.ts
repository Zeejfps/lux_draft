import { derived, get, type Readable } from 'svelte/store';
import type { EditorCommand } from '../../floorplan/types/command';
import type { EditorDocument } from '../../floorplan/types/document';
import type {
  DeadZoneConfig,
  LightDefinition,
  LightFixture,
  SpacingConfig,
  SpacingWarning,
} from './types';
import type { RafterConfig } from './types';
import { readModule } from '../../floorplan/types/module';
import type { LightingData } from './codec';
import { isBuiltinDefinitionId, lightingCodec, resolveDefinition } from './codec';
import {
  addFixture,
  moveFixture,
  removeFixture,
  setDeadZoneConfig,
  setDefinitions,
  setFixture,
  setRafterConfig,
  setSpacingConfig,
  type LightFixtureChanges,
} from './commands';
import { SpacingAnalyzer } from './SpacingAnalyzer';
import { committedDocument, roomStore, sessionStore } from '../../floorplan/stores/sessionStore';
import { documentSlice } from '../../floorplan/stores/documentSlice';
import { lightDefinitions } from './definitionsStore';

/**
 * The lighting module's read and write layer over `modules.lighting`.
 *
 * Everything lighting owns — fixtures, rafter config, dead-zone and spacing settings, and the
 * closure of custom definitions the fixtures reference — is document data since phase 3b, so
 * every read here is a projection of the session and every write is one registered
 * `lighting.*` command.
 *
 * This file is lighting's, not core's: phase 4 moves it under `src/modules/lighting/` beside
 * `codec.ts` and `commands.ts`. It lives in `stores/` only because its neighbours do.
 */

const readLighting = (doc: EditorDocument): Readonly<LightingData> =>
  readModule(doc, lightingCodec);

/** Live view — includes the candidate command of a drag in progress. What renderers read. */
export const lightingData: Readable<Readonly<LightingData>> = documentSlice(
  roomStore,
  readLighting
);

/** Committed view. What panels that must not flicker mid-gesture read. */
export const committedLightingData: Readable<Readonly<LightingData>> = documentSlice(
  committedDocument,
  readLighting
);

/** Live fixtures. Reference-stable between edits, so a renderer rebuild is a real change. */
export const fixtures: Readable<LightFixture[]> = documentSlice(
  roomStore,
  (doc) => readLighting(doc).fixtures
);

export const rafterConfig: Readable<RafterConfig> = documentSlice(
  committedDocument,
  (doc) => readLighting(doc).rafterConfig
);

export const deadZoneConfig: Readable<DeadZoneConfig> = documentSlice(
  committedDocument,
  (doc) => readLighting(doc).deadZone
);

export const spacingConfig: Readable<SpacingConfig> = documentSlice(
  committedDocument,
  (doc) => readLighting(doc).spacing
);

/** Derived, never stored (invariant 5). */
const analyzer = new SpacingAnalyzer();

export const spacingWarnings = derived(
  [roomStore, lightingData, spacingConfig],
  ([$room, $lighting, $config]): SpacingWarning[] => {
    if (!$config.enabled || $lighting.fixtures.length < 2) return [];
    return analyzer.analyzeSpacing($lighting.fixtures, $room.space.ceilingHeight, $config);
  }
);

/** The current slice, read synchronously. Setters need it; prefer the stores for reads. */
function current(): Readonly<LightingData> {
  return readLighting(sessionStore.current().document);
}

// ============================================
// Definitions — document first, picker library second
// ============================================

/**
 * What the fixture picker offers: the local library plus any definition this document carries
 * that the library does not have. The **document's** copy of a shared id wins, which is the
 * fix for a share link rendering the sender's fixtures with the recipient's photometry.
 */
export const pickerDefinitions: Readable<LightDefinition[]> = derived(
  [lightDefinitions, committedLightingData],
  ([$library, $lighting]) => {
    const merged = $library.map((d) => resolveDefinition($lighting, d.id) ?? d);
    const known = new Set(merged.map((d) => d.id));
    return [...merged, ...$lighting.definitions.filter((d) => !known.has(d.id))];
  }
);

/** Photometry for one id. The document's copy wins; the picker library is the fallback. */
export function resolveFixtureDefinition(
  data: Pick<LightingData, 'definitions'>,
  definitionId: string
): LightDefinition | undefined {
  return resolveDefinition(data, definitionId, get(lightDefinitions));
}

/**
 * The explicit post-`open` adoption step that replaces the old merge-on-decode side effect.
 *
 * Decode is pure now, so nothing a document carries reaches the global picker library on its
 * own. This offers the definitions an incoming document references — and only the ids the
 * library does not already have, so a local `custom-abc` is never overwritten by a stranger's.
 * The document's copy is what renders either way.
 *
 * Takes the definitions rather than a document: since phase 5 the module's own `onActivate`
 * runs this off `committedLightingData`, so the shell no longer calls it at every load site.
 * The viewer, which has no activation registry, still calls it by hand.
 */
export function adoptIncomingDefinitions(incoming: readonly LightDefinition[]): void {
  if (incoming.length === 0) return;
  lightDefinitions.update((library) => {
    const known = new Set(library.map((d) => d.id));
    const unknown = incoming.filter((d) => !known.has(d.id));
    return unknown.length === 0 ? library : [...library, ...unknown.map((d) => ({ ...d }))];
  });
}

// ============================================
// Writes — one registered command each
// ============================================

export function addLight(fixture: LightFixture, definition?: LightDefinition): void {
  // A fixture placed from the picker may reference a definition the document does not carry
  // yet; passing it here is what keeps `LightingData.definitions` a closed closure.
  sessionStore.dispatch(addFixture.make(definition ? { fixture, definition } : { fixture }));
}

export function moveLight(fixtureId: string, position: { x: number; y: number }): void {
  sessionStore.dispatch(moveFixture.make({ fixtureId, position }));
}

/**
 * Point fixtures at a definition, copying its photometry onto each one.
 *
 * A non-builtin definition is adopted into the document's closure in the same command, and it
 * has to come **last**: `definitions.set` normalizes against the fixtures as they are after the
 * `fixture.set`s, so a definition added before them would be pruned as unreferenced.
 */
export function applyDefinitionToFixtures(
  ids: Iterable<string>,
  definition: LightDefinition
): void {
  const changes: LightFixtureChanges = {
    definitionId: definition.id,
    properties: {
      lumen: definition.lumen,
      beamAngle: definition.beamAngle,
      warmth: definition.warmth,
    },
  };
  const commands: EditorCommand[] = [...ids].map((fixtureId) =>
    setFixture.make({ fixtureId, changes })
  );
  if (commands.length === 0) return;
  if (!isBuiltinDefinitionId(definition.id)) {
    const kept = current().definitions.filter((d) => d.id !== definition.id);
    commands.push(setDefinitions.make({ definitions: [...kept, definition] }));
  }
  dispatchMany(commands, 'Change lights');
}

export function removeLights(ids: Iterable<string>): void {
  dispatchMany(
    [...ids].map((fixtureId) => removeFixture.make({ fixtureId })),
    'Delete lights'
  );
}

function dispatchMany(commands: EditorCommand[], label: string): void {
  if (commands.length === 0) return;
  sessionStore.dispatch(
    commands.length === 1 ? commands[0] : { type: 'compound', label, commands }
  );
}

export function updateRafterConfig(changes: Partial<RafterConfig>): void {
  sessionStore.dispatch(
    setRafterConfig.make({ config: { ...current().rafterConfig, ...changes } })
  );
}

export function toggleRafters(): void {
  updateRafterConfig({ visible: !current().rafterConfig.visible });
}

export function setRafterOrientation(orientation: 'horizontal' | 'vertical'): void {
  updateRafterConfig({ orientation });
}

export function setRafterSpacing(spacing: number): void {
  updateRafterConfig({ spacing });
}

export function toggleDeadZones(): void {
  const config = current().deadZone;
  sessionStore.dispatch(
    setDeadZoneConfig.make({ config: { ...config, enabled: !config.enabled } })
  );
}

export function toggleSpacingWarnings(): void {
  const config = current().spacing;
  sessionStore.dispatch(setSpacingConfig.make({ config: { ...config, enabled: !config.enabled } }));
}
