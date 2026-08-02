import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Scene } from '../../../src/floorplan/core/Scene';
import type { InputEvent, InputEventType } from '../../../src/floorplan/core/InputManager';
import { InputManager } from '../../../src/floorplan/core/InputManager';

/**
 * Where a gesture is allowed to begin, continue and end.
 *
 * The bug this file exists for: a press on the canvas that is released anywhere else — over a
 * floating panel, over the toolbar, outside the window — left `isDragging` true forever, because
 * `mouseup` was bound to the canvas and the canvas never got one. The next mouse move then read
 * as a drag with no button held, and the selected wall followed the cursor with no way to put it
 * down. Selecting a wall makes its property panel appear, often right under the pointer, so the
 * release lands on the panel and the very act of selecting arms the bug.
 */

class FakeScene {
  readonly domElement = document.createElement('canvas');
  panned = 0;

  screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    return { x: screenX / 10, y: screenY / 10 };
  }

  pan(): void {
    this.panned += 1;
  }

  getZoom(): number {
    return 1;
  }

  zoomAt(): void {}
}

let scene: FakeScene;
let manager: InputManager;
let panel: HTMLDivElement;
let seen: InputEvent[];

const record = (type: InputEventType): void => {
  manager.on(type, (event) => seen.push(event));
};

const mouse = (target: EventTarget, type: string, x = 100, y = 100, button = 0): void => {
  target.dispatchEvent(
    new MouseEvent(type, { clientX: x, clientY: y, button, bubbles: true, cancelable: true })
  );
};

const types = (): InputEventType[] => seen.map((e) => e.type);

beforeEach(() => {
  scene = new FakeScene();
  document.body.appendChild(scene.domElement);
  panel = document.createElement('div');
  document.body.appendChild(panel);

  manager = new InputManager(scene as unknown as Scene);
  seen = [];
  for (const type of ['click', 'move', 'drag', 'mouseup', 'cancel'] as InputEventType[]) {
    record(type);
  }
});

afterEach(() => {
  manager.dispose();
  scene.domElement.remove();
  panel.remove();
});

describe('a gesture that ends outside the canvas', () => {
  it('is ended by the release, wherever it lands', () => {
    mouse(scene.domElement, 'mousedown');
    mouse(panel, 'mouseup', 300, 300);
    expect(types()).toEqual(['click', 'mouseup']);

    // The gesture is over, so a move over the canvas is a hover and nothing more. Before the
    // fix this was a `drag`, forever.
    seen = [];
    mouse(scene.domElement, 'mousemove', 150, 150);
    expect(types()).toEqual(['move']);
  });

  it('keeps following the pointer while it is over something else', () => {
    // The pointer crossing a panel mid-drag must not freeze the drag; the wall should track the
    // cursor the whole way and land where it was released.
    mouse(scene.domElement, 'mousedown');
    seen = [];
    mouse(panel, 'mousemove', 200, 200);
    expect(types()).toEqual(['drag']);
    expect(seen[0].worldPos).toEqual({ x: 20, y: 20 });
  });

  it('reports the release position, so the drag commits where the pointer actually was', () => {
    mouse(scene.domElement, 'mousedown');
    seen = [];
    mouse(panel, 'mouseup', 250, 250);
    expect(seen).toHaveLength(1);
    expect(seen[0].worldPos).toEqual({ x: 25, y: 25 });
  });
});

describe('what may not start a gesture', () => {
  it('a press outside the canvas starts nothing', () => {
    mouse(panel, 'mousedown');
    mouse(panel, 'mousemove', 200, 200);
    expect(seen).toHaveLength(0);
  });

  it('a stray release outside the canvas is silent', () => {
    // Nothing is in flight, so there is nothing to end — emitting `mouseup` here would tell a
    // drag operation to commit a gesture that never happened.
    mouse(panel, 'mouseup');
    expect(seen).toHaveLength(0);
  });

  it('a plain move over a panel is not a hover on the drawing', () => {
    mouse(panel, 'mousemove', 200, 200);
    expect(seen).toHaveLength(0);
  });
});

describe('the ordinary case still works', () => {
  it('press, move, release on the canvas is click, drag, mouseup — each once', () => {
    mouse(scene.domElement, 'mousedown');
    mouse(scene.domElement, 'mousemove', 120, 120);
    mouse(scene.domElement, 'mouseup', 120, 120);
    expect(types()).toEqual(['click', 'drag', 'mouseup']);
  });

  it('a hover with no button down is a move', () => {
    mouse(scene.domElement, 'mousemove', 120, 120);
    expect(types()).toEqual(['move']);
  });

  it('losing the window cancels whatever was in flight', () => {
    mouse(scene.domElement, 'mousedown');
    seen = [];
    window.dispatchEvent(new Event('blur'));
    expect(types()).toEqual(['cancel']);

    seen = [];
    mouse(scene.domElement, 'mousemove', 150, 150);
    expect(types()).toEqual(['move']);
  });

  it('disposal takes the window listeners with it', () => {
    mouse(scene.domElement, 'mousedown');
    manager.dispose();
    seen = [];
    mouse(panel, 'mousemove', 200, 200);
    mouse(panel, 'mouseup', 200, 200);
    expect(seen).toHaveLength(0);
  });
});
