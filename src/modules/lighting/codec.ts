import type {
  LightDefinition,
  LightFixture,
  DeadZoneConfig,
  SpacingConfig,
} from '../../types/lighting';
import type { RafterConfig } from '../../types/state';
import type { DecodeResult, ModuleBlob, ModuleCodec } from '../../types/module';
import {
  DEFAULT_DEAD_ZONE_CONFIG,
  DEFAULT_LIGHT_DEFINITIONS,
  DEFAULT_SPACING_CONFIG,
} from '../../types/lighting';
import { DEFAULT_RAFTER_CONFIG } from '../../types/state';

/**
 * The lighting module's data schema and codec. **Eager** (invariant 7): no `three`, no
 * `*.svelte`, no `runtime.ts`, no store — `decodeDocument` is synchronous and runs before any
 * runtime is imported. The phase-0 lint rules on every module's `codec.ts` enforce that.
 *
 * Phase 3a builds this against fixtures only; nothing reads it yet. Phase 3b makes it the live
 * home of the data that currently sits at `EditorDocument.lights` / `.rafterConfig`.
 */

export const LIGHTING_MODULE_ID = 'lighting';

/** Bumped by this module alone. The envelope version and other modules are unaffected. */
export const LIGHTING_SCHEMA_VERSION = 1;

/**
 * Everything the lighting module owns.
 *
 * `definitions` is the closure of **non-builtin** definitions referenced by `fixtures`; the
 * built-ins resolve by id from `DEFAULT_LIGHT_DEFINITIONS`. It is neither geometry nor an
 * opaque blob nor derived output — it is a referenced asset library, and putting it on the
 * document is what fixes the live bug where a share link whose `custom-abc` differs from the
 * recipient's `custom-abc` renders the sender's fixtures with the recipient's photometry.
 */
export interface LightingData {
  fixtures: LightFixture[];
  rafterConfig: RafterConfig;
  deadZone: DeadZoneConfig;
  spacing: SpacingConfig;
  definitions: LightDefinition[];
}

const BUILTIN_DEFINITION_IDS = new Set(DEFAULT_LIGHT_DEFINITIONS.map((d) => d.id));

export function isBuiltinDefinitionId(id: string): boolean {
  return BUILTIN_DEFINITION_IDS.has(id);
}

/** Freshly allocated on every call, all the way down. Never share a literal. */
export function defaultLightingData(): LightingData {
  return {
    fixtures: [],
    rafterConfig: { ...DEFAULT_RAFTER_CONFIG },
    deadZone: { ...DEFAULT_DEAD_ZONE_CONFIG, color: { ...DEFAULT_DEAD_ZONE_CONFIG.color } },
    spacing: { ...DEFAULT_SPACING_CONFIG },
    definitions: [],
  };
}

/** The non-builtin definitions these fixtures reference, in `definitions` order. */
export function referencedDefinitions(
  fixtures: readonly LightFixture[],
  definitions: readonly LightDefinition[]
): LightDefinition[] {
  const used = new Set(
    fixtures
      .map((f) => f.definitionId)
      .filter((id): id is string => id !== undefined && !isBuiltinDefinitionId(id))
  );
  return definitions.filter((d) => used.has(d.id)).map((d) => ({ ...d }));
}

/**
 * Resolve a fixture's photometry. **The document's copy wins** over the local picker library —
 * that is the fix. A document that renders differently depending on which machine opens it is
 * broken.
 */
export function resolveDefinition(
  data: Pick<LightingData, 'definitions'>,
  definitionId: string,
  library: readonly LightDefinition[] = DEFAULT_LIGHT_DEFINITIONS
): LightDefinition | undefined {
  return (
    data.definitions.find((d) => d.id === definitionId) ??
    library.find((d) => d.id === definitionId)
  );
}

// ============================================
// Validation
// ============================================

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

class SliceInvalid extends Error {}

function fail(message: string): never {
  throw new SliceInvalid(message);
}

function readVector2(value: unknown, path: string): { x: number; y: number } {
  if (!isRecord(value)) fail(`${path} must be an object`);
  if (!isFiniteNumber(value.x) || !isFiniteNumber(value.y)) fail(`${path} must have numeric x/y`);
  return { x: value.x, y: value.y };
}

function readFixture(value: unknown, path: string): LightFixture {
  if (!isRecord(value)) fail(`${path} must be an object`);
  if (typeof value.id !== 'string') fail(`${path}.id must be a string`);
  const props = value.properties;
  if (!isRecord(props)) fail(`${path}.properties must be an object`);
  if (!isFiniteNumber(props.lumen) || props.lumen < 0) {
    fail(`${path}.properties.lumen must be a non-negative number`);
  }
  if (!isFiniteNumber(props.beamAngle) || props.beamAngle <= 0 || props.beamAngle > 180) {
    fail(`${path}.properties.beamAngle must be between 0 and 180`);
  }
  if (!isFiniteNumber(props.warmth) || props.warmth < 1000 || props.warmth > 10000) {
    fail(`${path}.properties.warmth must be between 1000K and 10000K`);
  }
  const fixture: LightFixture = {
    id: value.id,
    position: readVector2(value.position, `${path}.position`),
    properties: { lumen: props.lumen, beamAngle: props.beamAngle, warmth: props.warmth },
  };
  if (typeof value.definitionId === 'string') fixture.definitionId = value.definitionId;
  return fixture;
}

function readDefinition(value: unknown, path: string): LightDefinition {
  if (!isRecord(value)) fail(`${path} must be an object`);
  if (typeof value.id !== 'string' || value.id === '') fail(`${path}.id must be a string`);
  if (typeof value.name !== 'string') fail(`${path}.name must be a string`);
  if (!isFiniteNumber(value.lumen) || value.lumen < 0) fail(`${path}.lumen must be >= 0`);
  if (!isFiniteNumber(value.beamAngle) || value.beamAngle <= 0 || value.beamAngle > 180) {
    fail(`${path}.beamAngle must be between 0 and 180`);
  }
  if (!isFiniteNumber(value.warmth) || value.warmth < 1000 || value.warmth > 10000) {
    fail(`${path}.warmth must be between 1000K and 10000K`);
  }
  return {
    id: value.id,
    name: value.name,
    lumen: value.lumen,
    beamAngle: value.beamAngle,
    warmth: value.warmth,
  };
}

/**
 * Optional sub-configs merge onto a fresh default rather than failing, so a v1 document
 * written before `deadZone` and `spacing` existed — every document the legacy envelope readers
 * produce — decodes clean instead of quarantining.
 */
function readRafterConfig(value: unknown): RafterConfig {
  const base = { ...DEFAULT_RAFTER_CONFIG };
  if (value === undefined || value === null) return base;
  if (!isRecord(value)) fail('rafterConfig must be an object');
  if (value.orientation === 'horizontal' || value.orientation === 'vertical') {
    base.orientation = value.orientation;
  }
  if (isFiniteNumber(value.spacing) && value.spacing > 0) base.spacing = value.spacing;
  if (isFiniteNumber(value.offsetX)) base.offsetX = value.offsetX;
  if (isFiniteNumber(value.offsetY)) base.offsetY = value.offsetY;
  if (typeof value.visible === 'boolean') base.visible = value.visible;
  return base;
}

function readDeadZone(value: unknown): DeadZoneConfig {
  const base = defaultLightingData().deadZone;
  if (value === undefined || value === null) return base;
  if (!isRecord(value)) fail('deadZone must be an object');
  if (typeof value.enabled === 'boolean') base.enabled = value.enabled;
  if (isFiniteNumber(value.threshold)) base.threshold = value.threshold;
  if (isFiniteNumber(value.opacity)) base.opacity = value.opacity;
  if (isRecord(value.color)) {
    const { r, g, b } = value.color;
    if (isFiniteNumber(r) && isFiniteNumber(g) && isFiniteNumber(b)) base.color = { r, g, b };
  }
  return base;
}

function readSpacing(value: unknown): SpacingConfig {
  const base = { ...DEFAULT_SPACING_CONFIG };
  if (value === undefined || value === null) return base;
  if (!isRecord(value)) fail('spacing must be an object');
  if (typeof value.enabled === 'boolean') base.enabled = value.enabled;
  if (isFiniteNumber(value.overlapFactor) && value.overlapFactor > 0) {
    base.overlapFactor = value.overlapFactor;
  }
  if (isFiniteNumber(value.gapTolerance) && value.gapTolerance >= 0) {
    base.gapTolerance = value.gapTolerance;
  }
  return base;
}

function decodeLighting(blob: ModuleBlob): DecodeResult<LightingData> {
  if (!Number.isInteger(blob.v) || blob.v < 1) {
    return {
      status: 'invalid',
      message: `lighting slice has no usable schema version (v=${JSON.stringify(blob.v)})`,
    };
  }
  if (blob.v > LIGHTING_SCHEMA_VERSION) {
    return {
      status: 'unsupported',
      writtenVersion: blob.v,
      message:
        `lighting data was written at schema version ${blob.v}; this build reads up to ` +
        `${LIGHTING_SCHEMA_VERSION}`,
    };
  }

  try {
    if (!isRecord(blob.data)) fail('lighting slice must be an object');
    const raw = blob.data;

    if (raw.fixtures !== undefined && !Array.isArray(raw.fixtures)) {
      fail('fixtures must be an array');
    }
    if (raw.definitions !== undefined && !Array.isArray(raw.definitions)) {
      fail('definitions must be an array');
    }

    const fixtures = ((raw.fixtures as unknown[]) ?? []).map((f, i) =>
      readFixture(f, `fixtures[${i}]`)
    );
    const definitions = ((raw.definitions as unknown[]) ?? []).map((d, i) =>
      readDefinition(d, `definitions[${i}]`)
    );

    return {
      status: 'ok',
      data: {
        fixtures,
        rafterConfig: readRafterConfig(raw.rafterConfig),
        deadZone: readDeadZone(raw.deadZone),
        spacing: readSpacing(raw.spacing),
        // Keep the closure the document actually needs. A definition nobody references is
        // dead weight, and dropping it here is what makes decode → encode → decode stable.
        definitions: referencedDefinitions(fixtures, definitions),
      },
    };
  } catch (e) {
    if (e instanceof SliceInvalid) return { status: 'invalid', message: e.message };
    throw e;
  }
}

/**
 * A share link is a single-module view: keep the fixtures, the rafters the viewer draws, and
 * the definition closure — drop the analysis settings, which are authoring state.
 *
 * Returns `LightingData`, so the result is written at `schemaVersion` and read back by
 * `decodeLighting` unchanged.
 */
function compactLightingForShare(data: Readonly<LightingData>): LightingData {
  const fresh = defaultLightingData();
  return {
    fixtures: data.fixtures.map((f) => ({ ...f, position: { ...f.position } })),
    rafterConfig: { ...data.rafterConfig },
    deadZone: fresh.deadZone,
    spacing: fresh.spacing,
    definitions: referencedDefinitions(data.fixtures, data.definitions),
  };
}

export const lightingCodec: ModuleCodec<LightingData> = {
  id: LIGHTING_MODULE_ID,
  schemaVersion: LIGHTING_SCHEMA_VERSION,
  defaultData: defaultLightingData,
  decode: decodeLighting,
  compactForShare: compactLightingForShare,
};
