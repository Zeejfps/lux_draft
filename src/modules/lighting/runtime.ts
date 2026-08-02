import { derived, get } from 'svelte/store';
import type { IInteractionHandler } from '../../floorplan/types/interaction';
import type {
  ActivationScope,
  ModuleContext,
  ModuleRuntime,
  ModuleView,
  OverlayToggle,
  PanelComponent,
  SceneLayer,
} from '../../floorplan/types/moduleRuntime';
import type { EntityDescriptor } from '../../floorplan/types/entity';
import { PolygonValidator } from '../../floorplan/geometry/PolygonValidator';
import { SnapController } from '../../floorplan/controllers/SnapController';
import type { WallSegment } from '../../floorplan/types';
import type { LightDefinition } from './types';
import { LIGHTING_MODULE_ID, type LightingData } from './codec';
import { fixtureEntities } from './entities';
import { LIGHTING_TOOL_PLACE } from './constants';
import { fixtureSelection } from './selection';
import { LightManager } from './LightManager';
import { LightPlacementHandler } from './LightPlacementHandler';
import { createLightingLayers } from './layers';
import {
  adoptIncomingDefinitions,
  addLight,
  committedLightingData,
  deadZoneConfig,
  pickerDefinitions,
  rafterConfig,
  spacingConfig,
  toggleDeadZones,
  toggleRafters,
  toggleSpacingWarnings,
} from './store';
import {
  definitionManagerVisible,
  selectedDefinitionId,
  toggleDefinitionManager,
} from './definitionsStore';
import { lightingStatsConfig, toggleLightingStats } from './statsStore';
import LightDefinitionManager from './ui/LightDefinitionManager.svelte';
import LightPropertiesPanel from './ui/LightPropertiesPanel.svelte';
import LightToolPanel from './ui/LightToolPanel.svelte';
import LightingStatsPanel from './ui/LightingStatsPanel.svelte';
import RafterControls from './ui/RafterControls.svelte';

/**
 * The lighting module's **lazy** half (invariant 7).
 *
 * `codec.ts` and `commands.ts` may not import this file, and the lint enforces it: everything
 * reachable from here — THREE, the IES parser, the heatmap shaders, six renderers and every
 * lighting panel — stays out of the eager chunk that `decodeDocument` needs.
 *
 * Nothing here disposes anything. The registry owns disposal: layers, handlers, panels and the
 * subscription below all belong to the activation scope.
 */

const RAFTERS_ICON = `<line x1="3" y1="6" x2="21" y2="6" />
  <line x1="3" y1="12" x2="21" y2="12" />
  <line x1="3" y1="18" x2="21" y2="18" />`;

const DEAD_ZONES_ICON = `<path
    d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
  />
  <line x1="12" y1="9" x2="12" y2="13" />
  <line x1="12" y1="17" x2="12.01" y2="17" />`;

const SPACING_ICON = `<path d="M21 10H3" />
  <path d="M21 6H3" />
  <path d="M21 14H3" />
  <path d="M21 18H3" />
  <path d="M6 6v12" />
  <path d="M18 6v12" />`;

const STATS_ICON = `<line x1="18" y1="20" x2="18" y2="10" />
  <line x1="12" y1="20" x2="12" y2="4" />
  <line x1="6" y1="20" x2="6" y2="14" />`;

const DEFINITIONS_ICON = `<circle cx="12" cy="12" r="3" />
  <path
    d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"
  />`;

const ICON = `<line x1="12" y1="1" x2="12" y2="3" />
  <line x1="12" y1="21" x2="12" y2="23" />
  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
  <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
  <line x1="1" y1="12" x2="3" y2="12" />
  <line x1="21" y1="12" x2="23" y2="12" />
  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
  <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
  <circle cx="12" cy="12" r="5" />`;

/**
 * Per-activation state. The registry calls `layers()` then `handlers()` then `onActivate()` for
 * one activation at a time, so a single holder is enough — and `onActivate` hands it to the
 * scope, which clears it on teardown so nothing survives into the next activation.
 */
interface ActivationState {
  lightRenderer: ReturnType<typeof createLightingLayers>['lightRenderer'];
  definitions: LightDefinition[];
}

let activation: ActivationState | null = null;

/**
 * The toolbar's Overlay section, contributed rather than hardcoded.
 *
 * Before phase 5 each of these was a button in `app/Toolbar.svelte` reading a lighting store,
 * which put lighting's store graph — and through it most of the module — in the eager chunk.
 * Coming through the manifest, they travel with this file.
 */
const OVERLAYS: readonly OverlayToggle[] = [
  {
    id: `${LIGHTING_MODULE_ID}.rafters`,
    label: 'Rafters',
    title: 'Toggle Rafters (R)',
    icon: RAFTERS_ICON,
    active: derived(rafterConfig, ($config) => $config.visible),
    toggle: () => toggleRafters(),
  },
  {
    id: `${LIGHTING_MODULE_ID}.deadZones`,
    label: 'Dead Zones',
    title: 'Toggle Dead Zones',
    icon: DEAD_ZONES_ICON,
    active: derived(deadZoneConfig, ($config) => $config.enabled),
    toggle: () => toggleDeadZones(),
  },
  {
    id: `${LIGHTING_MODULE_ID}.spacing`,
    label: 'Spacing',
    title: 'Toggle Spacing Warnings',
    icon: SPACING_ICON,
    active: derived(spacingConfig, ($config) => $config.enabled),
    toggle: () => toggleSpacingWarnings(),
  },
  {
    id: `${LIGHTING_MODULE_ID}.stats`,
    label: 'Stats',
    title: 'Toggle Lighting Stats (Q)',
    icon: STATS_ICON,
    active: derived(lightingStatsConfig, ($config) => $config.visible),
    toggle: () => toggleLightingStats(),
  },
  {
    id: `${LIGHTING_MODULE_ID}.definitions`,
    label: 'Lights',
    title: 'Manage Light Definitions',
    icon: DEFINITIONS_ICON,
    active: definitionManagerVisible,
    toggle: () => toggleDefinitionManager(),
  },
];

export const lightingRuntime: ModuleRuntime = {
  id: LIGHTING_MODULE_ID,
  label: 'Lighting',

  tools: [
    {
      id: LIGHTING_TOOL_PLACE,
      label: 'Light',
      title: 'Place Lights (L)',
      disabledTitle: 'Close room first',
      key: 'l',
      icon: ICON,
      enabled: (view: ModuleView<unknown>) => view.geometry.boundary.isClosed,
    },
  ],

  overlays: OVERLAYS,

  entities: fixtureEntities as EntityDescriptor<unknown>,

  // `.svelte` default exports type as Svelte's legacy component shape; the registry wants
  // the no-props form, and every panel reads its own stores rather than taking props.
  panels: { [fixtureSelection.panelKey]: LightPropertiesPanel as unknown as PanelComponent },

  // Free-standing UI, mounted by the shell for as long as this module is active. Each guards
  // its own visibility, so the shell mounts the list and names none of them.
  surfaces: [
    LightToolPanel,
    RafterControls,
    LightingStatsPanel,
    LightDefinitionManager,
  ] as unknown as PanelComponent[],

  shortcuts: [
    { key: 'r', description: 'Toggle rafter overlay', run: () => toggleRafters() },
    { key: 'q', description: 'Toggle lighting stats', run: () => toggleLightingStats() },
  ],

  layers(scene): SceneLayer[] {
    const built = createLightingLayers(scene);
    activation = { lightRenderer: built.lightRenderer, definitions: get(pickerDefinitions) };
    return built.layers;
  },

  handlers(ctx: ModuleContext<unknown>): IInteractionHandler[] {
    const view = () => ctx.view() as ModuleView<LightingData>;
    const lightManager = new LightManager((id) => activation?.definitions.find((d) => d.id === id));
    const placement = new LightPlacementHandler(
      {
        lightManager,
        polygonValidator: new PolygonValidator(),
        snapController: new SnapController(),
        getSelectedDefinitionId: () => get(selectedDefinitionId),
        canPlaceLights: () => view().geometry.boundary.isClosed,
        getWalls: () => view().geometry.boundary.walls as WallSegment[],
        getGridSnapEnabled: () => view().displayPreferences.gridSnapEnabled,
        getGridSize: () => view().displayPreferences.gridSize || 0.5,
      },
      {
        onLightPlaced: (light) => {
          // Pass the picker's definition so a custom one is adopted into the document's
          // closure by the same command that adds the fixture.
          const definition = light.definitionId
            ? activation?.definitions.find((d) => d.id === light.definitionId)
            : undefined;
          addLight(light, definition);
        },
        onSetPreviewLight: (pos, isValid) => activation?.lightRenderer.setPreview(pos, isValid),
      }
    );
    return [placement];
  },

  onActivate(_ctx: ModuleContext<unknown>, scope: ActivationScope): void {
    // A derived subscription the scope owns: the placement handler resolves photometry from
    // the picker view (the document's copy of a shared id wins over the local library's), and
    // reading it live rather than per click is what keeps a fixture placed mid-edit correct.
    const stop = pickerDefinitions.subscribe((definitions) => {
      if (activation) activation.definitions = definitions;
    });
    scope.own(stop);

    // The explicit post-`open` adoption step, owned by the module rather than called from
    // three places in the shell. `committedLightingData` is a guarded slice, so this runs on
    // activation and then only when the lighting slice actually changes — which is every load
    // (`sessionStore.beforeOpen` re-activates) and every import. Adoption adds only ids the
    // library lacks, so re-running it is a no-op.
    scope.own(
      committedLightingData.subscribe((data) => {
        adoptIncomingDefinitions(data.definitions);
      })
    );

    scope.own(() => {
      activation = null;
    });
  },
};
