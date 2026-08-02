import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as THREE from 'three';
import type { ModuleView, SceneLayer } from '../../../src/floorplan/types/moduleRuntime';
import { moduleViewOf } from '../../../src/floorplan/types/moduleRuntime';
import { EditorRenderer } from '../../../src/floorplan/rendering/EditorRenderer';
import { NO_SELECTION } from '../../../src/floorplan/types/selection';
import { DEFAULT_DISPLAY_PREFERENCES } from '../../../src/floorplan/types/state';
import { makeLight, squareRoom } from '../../helpers/documents';

/**
 * `EditorRenderer` holds a `SceneLayer[]` and loops.
 *
 * The point of the change is that there is no facade method per domain any more: a module's
 * layers go through the identical path core's do, and the renderer disposes only its own.
 */

function view(viewMode: 'editor' | 'shadow' | 'heatmap' = 'editor'): ModuleView<unknown> {
  return moduleViewOf(
    squareRoom({ lights: [makeLight('l1', { x: 1, y: 1 })] }),
    {},
    NO_SELECTION,
    DEFAULT_DISPLAY_PREFERENCES,
    viewMode
  );
}

function recordingLayer(id: string): SceneLayer & { updates: number; disposed: number } {
  const layer = {
    id,
    updates: 0,
    disposed: 0,
    update() {
      layer.updates += 1;
    },
    setVisible() {},
    dispose() {
      layer.disposed += 1;
    },
  };
  return layer;
}

let scene: THREE.Scene;
let renderer: EditorRenderer;

// jsdom has no 2D canvas; dimension labels are text sprites and would throw without one.
const originalGetContext = HTMLCanvasElement.prototype.getContext;
beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn((kind: string) =>
    kind === '2d'
      ? ({
          font: '',
          fillStyle: '',
          textAlign: '',
          textBaseline: '',
          measureText: () => ({ width: 10 }),
          fillRect: () => {},
          fillText: () => {},
          clearRect: () => {},
          beginPath: () => {},
          roundRect: () => {},
          fill: () => {},
        } as unknown as CanvasRenderingContext2D)
      : originalGetContext.call(HTMLCanvasElement.prototype, kind as never)
  ) as typeof HTMLCanvasElement.prototype.getContext;
  scene = new THREE.Scene();
  renderer = new EditorRenderer(scene);
});

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext;
});

describe('EditorRenderer as a layer loop', () => {
  it('renders module layers through the same pass as core layers', () => {
    const a = recordingLayer('m.a');
    const b = recordingLayer('m.b');
    renderer.setModuleLayers([a, b]);

    renderer.render(view());
    renderer.render(view());

    expect(a.updates).toBe(2);
    expect(b.updates).toBe(2);
  });

  it('skips a layer whose `inputs` are reference-equal to the last call', () => {
    const layer = recordingLayer('m.memo');
    const inputs = { stable: true };
    renderer.setModuleLayers([{ ...layer, inputs: () => inputs, update: layer.update }]);

    renderer.render(view());
    renderer.render(view());
    renderer.render(view());

    expect(layer.updates).toBe(1);
  });

  it('disposes only its own layers — the activation scope owns the module’s', () => {
    const module = recordingLayer('m.a');
    renderer.setModuleLayers([module]);
    renderer.render(view());

    const drawn = () => scene.children.reduce((n, group) => n + group.children.length, 0);
    expect(drawn()).toBeGreaterThan(0);

    renderer.dispose();
    // Core's own layers are emptied…
    expect(drawn()).toBe(0);
    // …and the module's is not touched: it belongs to the activation scope, which disposes it.
    expect(module.disposed).toBe(0);
  });

  it('core layers follow the view mode without anyone calling setVisible', () => {
    renderer.render(view('editor'));
    const visibleInEditor = scene.children.filter((c) => c.visible).length;
    renderer.render(view('heatmap'));
    const visibleInHeatmap = scene.children.filter((c) => c.visible).length;

    expect(visibleInEditor).toBeGreaterThan(0);
    expect(visibleInHeatmap).toBeLessThan(visibleInEditor);
  });
});
