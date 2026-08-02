import * as THREE from 'three';
import type { Door, WallSegment } from '../../floorplan/types/geometry';
import type { ModuleView, SceneLayer } from '../../floorplan/types/moduleRuntime';
import type { FlooringData } from './codec';
import { liveTransitions } from './codec';
import { layoutInputsOf } from './layoutProjection';
import { layoutKey } from './PlankLayoutEngine';
import { isOriginSelected } from './selection';
import { hoveredPlank, planksVisible, plankLayout, requestLayout } from './store';
import { PlankRenderer } from './rendering/PlankRenderer';
import { TransitionRenderer } from './rendering/TransitionRenderer';
import { OriginMarkerRenderer } from './rendering/OriginMarkerRenderer';

/**
 * Flooring's scene layers.
 *
 * The plank layer is where the projection meets the renderer, and the two seams the plan named
 * are both used here:
 *
 * - **`SceneLayer.inputs?`** returns the layout's structural key. Selecting the origin, opening
 *   a panel or moving the mouse changes the view but not the key, so `update` is skipped
 *   entirely — the first real use of `inputs?`, which phase 4 left unimplemented on purpose.
 * - **The projection** answers `requestLayout` immediately with the last good floor and
 *   computes the new one off the frame. The layer subscribes to the result, so an asynchronous
 *   answer still reaches the screen without a second render pass being scheduled by the shell.
 *
 * Nothing here disposes itself from the outside: the activation scope owns every layer, and
 * each layer's own `dispose` releases the store subscriptions it opened.
 */

type View = ModuleView<FlooringData>;

export interface FlooringLayers {
  readonly layers: SceneLayer[];
}

export function createFlooringLayers(scene: THREE.Scene): FlooringLayers {
  const plankRenderer = new PlankRenderer(scene);
  const transitionRenderer = new TransitionRenderer(scene);
  const originRenderer = new OriginMarkerRenderer(scene);

  let visible = true;
  let inEditorView = true;

  const applyVisibility = (): void => plankRenderer.setVisible(visible && inEditorView);

  // A layout that arrives late — the ordinary case, since computing is deferred — pushes
  // straight into the renderer. Without this the floor would appear only on the next unrelated
  // document change.
  const stopLayout = plankLayout.subscribe((layout) => plankRenderer.update(layout));
  const stopHover = hoveredPlank.subscribe((plank) => plankRenderer.setHovered(plank?.id ?? null));
  const stopVisible = planksVisible.subscribe((next) => {
    visible = next;
    applyVisibility();
  });

  const planks: SceneLayer = {
    id: 'flooring.planks',
    // Narrow by construction: the key is a function of geometry and the slice, so a selection
    // change or a hover cannot invalidate a floor.
    inputs: (view) => `${layoutKey(layoutInputsOf(view as View))}|${view.viewMode}`,
    update(view) {
      inEditorView = view.viewMode === 'editor';
      applyVisibility();
      if (!inEditorView) return;
      // Never blocks: a hit is exact, a miss returns the previous floor and schedules the work.
      requestLayout(layoutInputsOf(view as View));
    },
    setVisible: (next) => plankRenderer.setVisible(next),
    dispose: () => {
      stopLayout();
      stopHover();
      stopVisible();
      plankRenderer.dispose();
    },
  };

  const transitions: SceneLayer = {
    id: 'flooring.transitions',
    update(view) {
      const v = view as View;
      transitionRenderer.setVisible(v.viewMode === 'editor');
      if (v.viewMode !== 'editor') return;
      const doors = v.geometry.doors as Door[];
      transitionRenderer.update(
        // Resolve through the doors: a transition whose door was deleted is inert, not drawn.
        liveTransitions(v.data.transitions, doors),
        doors,
        v.geometry.boundary.walls as WallSegment[],
        true
      );
    },
    setVisible: (next) => transitionRenderer.setVisible(next),
    dispose: () => transitionRenderer.dispose(),
  };

  const origin: SceneLayer = {
    id: 'flooring.origin',
    update(view) {
      const v = view as View;
      originRenderer.setVisible(v.viewMode === 'editor');
      if (v.viewMode !== 'editor') return;
      originRenderer.update(
        v.data.origin,
        v.data.layout.runAngleDeg,
        isOriginSelected(v.selection)
      );
    },
    setVisible: (next) => originRenderer.setVisible(next),
    dispose: () => originRenderer.dispose(),
  };

  return { layers: [planks, transitions, origin] };
}
