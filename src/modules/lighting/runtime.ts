import { get } from 'svelte/store';
import type { IInteractionHandler } from '../../floorplan/types/interaction';
import type {
  ActivationScope,
  ModuleContext,
  ModuleRuntime,
  ModuleView,
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
import { addLight, pickerDefinitions, toggleRafters } from './store';
import { selectedDefinitionId } from './definitionsStore';
import { toggleLightingStats } from './statsStore';
import LightPropertiesPanel from './ui/LightPropertiesPanel.svelte';
import LightingStatsPanel from './ui/LightingStatsPanel.svelte';

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

  entities: fixtureEntities as EntityDescriptor<unknown>,

  // `.svelte` default exports type as Svelte's legacy component shape; the registry wants
  // the no-props form, and every panel reads its own stores rather than taking props.
  panels: { [fixtureSelection.panelKey]: LightPropertiesPanel as unknown as PanelComponent },

  statsPanel: LightingStatsPanel as unknown as PanelComponent,

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
    scope.own(() => {
      activation = null;
    });
  },
};
