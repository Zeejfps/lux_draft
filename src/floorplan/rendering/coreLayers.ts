import * as THREE from 'three';
import type { ModuleView, SceneLayer } from '../types/moduleRuntime';
import {
  getSelectedDoorId,
  getSelectedObstacleId,
  getSelectedObstacleVertexIndices,
  getSelectedVertexIndices,
  getSelectedWallId,
} from '../types/selection';
import { WallRenderer } from './WallRenderer';
import { DoorRenderer } from './DoorRenderer';
import { ObstacleRenderer } from './ObstacleRenderer';

/**
 * Core's own document projections, as `SceneLayer`s.
 *
 * There is one update path for core and modules alike: `EditorRenderer` holds a `SceneLayer[]`
 * and loops, instead of naming each renderer as a field with a bespoke method. A layer decides
 * its own visibility from `view.viewMode`, which is what removed the per-domain
 * `setLightsVisible` / `updateViewMode` facade the canvas used to drive by hand.
 */

export const CORE_LAYER_IDS = ['core.walls', 'core.doors', 'core.obstacles'] as const;

export interface CoreLayers {
  readonly layers: SceneLayer[];
  /** Kept for the imperative door preview, which is gesture state and not a projection. */
  readonly doorRenderer: DoorRenderer;
}

export function createCoreLayers(scene: THREE.Scene): CoreLayers {
  const wallRenderer = new WallRenderer(scene);
  const doorRenderer = new DoorRenderer(scene);
  const obstacleRenderer = new ObstacleRenderer(scene);

  const wallLayer: SceneLayer = {
    id: 'core.walls',
    update(view: ModuleView<unknown>) {
      wallRenderer.setUnitFormat(view.displayPreferences.unitFormat);
      wallRenderer.setVisible(view.viewMode === 'editor');
      wallRenderer.update(
        view.geometry.boundary.walls as Parameters<WallRenderer['update']>[0],
        getSelectedWallId(view.selection),
        new Set(getSelectedVertexIndices(view.selection)),
        view.geometry.doors as Parameters<WallRenderer['update']>[3]
      );
    },
    setVisible: (visible) => wallRenderer.setVisible(visible),
    dispose: () => wallRenderer.dispose(),
  };

  const doorLayer: SceneLayer = {
    id: 'core.doors',
    update(view: ModuleView<unknown>) {
      doorRenderer.setVisible(view.viewMode === 'editor');
      doorRenderer.update(
        view.geometry.doors as Parameters<DoorRenderer['update']>[0],
        view.geometry.boundary.walls as Parameters<DoorRenderer['update']>[1],
        getSelectedDoorId(view.selection)
      );
    },
    setVisible: (visible) => doorRenderer.setVisible(visible),
    dispose: () => doorRenderer.dispose(),
  };

  const obstacleLayer: SceneLayer = {
    id: 'core.obstacles',
    update(view: ModuleView<unknown>) {
      obstacleRenderer.setUnitFormat(view.displayPreferences.unitFormat);
      obstacleRenderer.setVisible(view.viewMode === 'editor');
      obstacleRenderer.update(
        view.geometry.obstacles as Parameters<ObstacleRenderer['update']>[0],
        getSelectedObstacleId(view.selection),
        new Set(getSelectedObstacleVertexIndices(view.selection))
      );
    },
    setVisible: (visible) => obstacleRenderer.setVisible(visible),
    dispose: () => obstacleRenderer.dispose(),
  };

  return { layers: [wallLayer, doorLayer, obstacleLayer], doorRenderer };
}
