import * as THREE from 'three';
import type { ModuleView, SceneLayer } from '../../floorplan/types/moduleRuntime';
import { computeRoomBounds } from '../../floorplan/utils/geometry';
import type { Door, Obstacle, WallSegment } from '../../floorplan/types';
import type { LightingData } from './codec';
import { DEFAULT_RAFTER_CONFIG } from './types';
import { getSelectedFixtureIds } from './selection';
import { SpacingAnalyzer } from './SpacingAnalyzer';
import { LightRenderer } from './rendering/LightRenderer';
import { HeatmapRenderer } from './rendering/HeatmapRenderer';
import { ShadowRenderer } from './rendering/ShadowRenderer';
import { RafterOverlay } from './rendering/RafterOverlay';
import { DeadZoneRenderer } from './rendering/DeadZoneRenderer';
import { SpacingWarningRenderer } from './rendering/SpacingWarningRenderer';

/**
 * Lighting's scene layers.
 *
 * Every one of these used to be a field on `Canvas.svelte` fed by a hand-written `$:` block
 * reading four lighting stores. Now each derives everything it draws from the `ModuleView` it
 * is handed, including its own visibility — which is why `viewMode` is on the view.
 *
 * Nothing here disposes itself: the activation scope owns every layer (invariant: the registry
 * owns disposal).
 */

type View = ModuleView<LightingData>;

const mutableWalls = (view: View): WallSegment[] => view.geometry.boundary.walls as WallSegment[];
const mutableDoors = (view: View): Door[] => view.geometry.doors as Door[];
const mutableObstacles = (view: View): Obstacle[] => view.geometry.obstacles as Obstacle[];

export interface LightingLayers {
  readonly layers: SceneLayer[];
  /** The fixture layer, so the placement handler can drive its ghost preview. */
  readonly lightRenderer: LightRenderer;
}

export function createLightingLayers(scene: THREE.Scene): LightingLayers {
  const lightRenderer = new LightRenderer(scene);
  const heatmapRenderer = new HeatmapRenderer(scene);
  const shadowRenderer = new ShadowRenderer(scene);
  const rafterOverlay = new RafterOverlay(scene, { ...DEFAULT_RAFTER_CONFIG });
  const deadZoneRenderer = new DeadZoneRenderer(scene);
  const spacingWarningRenderer = new SpacingWarningRenderer(scene);
  const analyzer = new SpacingAnalyzer();

  const fixtures: SceneLayer = {
    id: 'lighting.fixtures',
    update(view: View) {
      // Fixtures are drawn in the layout view and kept visible under the shadow overlay,
      // which is what `setLightsVisible(mode === 'editor' || mode === 'shadow')` used to say.
      lightRenderer.setVisible(view.viewMode === 'editor' || view.viewMode === 'shadow');
      lightRenderer.setRadiusVisibility(view.displayPreferences.lightRadiusVisibility);
      lightRenderer.update(
        view.data.fixtures,
        view.space.ceilingHeight,
        new Set(getSelectedFixtureIds(view.selection))
      );
    },
    setVisible: (visible) => lightRenderer.setVisible(visible),
    dispose: () => lightRenderer.dispose(),
  };

  const heatmap: SceneLayer = {
    id: 'lighting.heatmap',
    update(view: View) {
      heatmapRenderer.setVisible(view.viewMode === 'heatmap');
      if (view.viewMode !== 'heatmap') return;
      heatmapRenderer.updateBounds(computeRoomBounds(view.geometry.boundary.walls));
      heatmapRenderer.updateWalls(mutableWalls(view));
      heatmapRenderer.updateObstacles(mutableObstacles(view));
      heatmapRenderer.updateLights(view.data.fixtures, view.space.ceilingHeight);
    },
    setVisible: (visible) => heatmapRenderer.setVisible(visible),
    dispose: () => heatmapRenderer.dispose(),
  };

  const shadows: SceneLayer = {
    id: 'lighting.shadows',
    update(view: View) {
      shadowRenderer.setVisible(view.viewMode === 'shadow');
      if (view.viewMode !== 'shadow') return;
      shadowRenderer.updateShadows(
        view.data.fixtures,
        mutableWalls(view),
        computeRoomBounds(view.geometry.boundary.walls),
        mutableDoors(view),
        mutableObstacles(view),
        view.space.ceilingHeight
      );
    },
    setVisible: (visible) => shadowRenderer.setVisible(visible),
    dispose: () => shadowRenderer.dispose(),
  };

  const rafters: SceneLayer = {
    id: 'lighting.rafters',
    update(view: View) {
      rafterOverlay.updateConfig(view.data.rafterConfig);
      rafterOverlay.render(computeRoomBounds(view.geometry.boundary.walls));
      rafterOverlay.setVisible(view.viewMode === 'editor' && view.data.rafterConfig.visible);
    },
    setVisible: (visible) => rafterOverlay.setVisible(visible),
    dispose: () => rafterOverlay.dispose(),
  };

  const deadZones: SceneLayer = {
    id: 'lighting.deadZones',
    update(view: View) {
      const enabled = view.viewMode === 'editor' && view.data.deadZone.enabled;
      deadZoneRenderer.setVisible(enabled);
      if (!enabled) return;
      deadZoneRenderer.updateConfig(view.data.deadZone);
      deadZoneRenderer.updateBounds(computeRoomBounds(view.geometry.boundary.walls));
      deadZoneRenderer.updateLights(view.data.fixtures, view.space.ceilingHeight);
    },
    setVisible: (visible) => deadZoneRenderer.setVisible(visible),
    dispose: () => deadZoneRenderer.dispose(),
  };

  const spacing: SceneLayer = {
    id: 'lighting.spacingWarnings',
    update(view: View) {
      const enabled = view.viewMode === 'editor' && view.data.spacing.enabled;
      spacingWarningRenderer.setVisible(enabled);
      if (!enabled) return;
      // Derived output, computed here and never stored (invariant 5).
      const warnings =
        view.data.fixtures.length < 2
          ? []
          : analyzer.analyzeSpacing(
              view.data.fixtures,
              view.space.ceilingHeight,
              view.data.spacing
            );
      spacingWarningRenderer.updateWarnings(warnings);
    },
    setVisible: (visible) => spacingWarningRenderer.setVisible(visible),
    dispose: () => spacingWarningRenderer.dispose(),
  };

  return {
    layers: [fixtures, heatmap, shadows, rafters, deadZones, spacing],
    lightRenderer,
  };
}
