import type { Vector2 } from '../types';
import type { Scene } from './Scene';
import { ZOOM_IN_FACTOR, ZOOM_OUT_FACTOR, PINCH_ZOOM_SENSITIVITY } from '../constants/editor';

export type InputEventType =
  | 'click'
  | 'dblclick'
  | 'move'
  | 'drag'
  | 'mouseup'
  | 'wheel'
  | 'keydown'
  | 'keyup'
  | 'contextmenu';

export interface InputEvent {
  type: InputEventType;
  worldPos: Vector2;
  screenPos: Vector2;
  button: number;
  key?: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  deltaY?: number;
}

export type InputHandler = (event: InputEvent) => void;

export class InputManager {
  private scene: Scene;
  private handlers: Map<InputEventType, InputHandler[]> = new Map();
  private isDragging: boolean = false;
  private isPanning: boolean = false;
  private lastMousePos: Vector2 = { x: 0, y: 0 };

  constructor(scene: Scene) {
    this.scene = scene;
    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    const canvas = this.scene.domElement;

    canvas.addEventListener('mousedown', this.handleMouseDown.bind(this));
    canvas.addEventListener('mousemove', this.handleMouseMove.bind(this));
    canvas.addEventListener('mouseup', this.handleMouseUp.bind(this));
    canvas.addEventListener('dblclick', this.handleDoubleClick.bind(this));
    // passive: false is required because we call preventDefault() to handle zoom
    canvas.addEventListener('wheel', this.handleWheel.bind(this), { passive: false });
    canvas.addEventListener('contextmenu', this.handleContextMenu.bind(this));

    // Safari also emits non-standard gesture events for a trackpad pinch; suppressing
    // them stops the page itself from zooming while we handle the ctrl+wheel version.
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
      canvas.addEventListener(type, (e: Event) => e.preventDefault());
    }

    window.addEventListener('keydown', this.handleKeyDown.bind(this));
    window.addEventListener('keyup', this.handleKeyUp.bind(this));
  }

  on(eventType: InputEventType, handler: InputHandler): void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, []);
    }
    this.handlers.get(eventType)!.push(handler);
  }

  private emit(eventType: InputEventType, event: InputEvent): void {
    const handlers = this.handlers.get(eventType);
    if (handlers) {
      for (const handler of handlers) {
        handler(event);
      }
    }
  }

  private createEvent(e: MouseEvent, type: InputEventType): InputEvent {
    const worldPos = this.scene.screenToWorld(e.clientX, e.clientY);
    return {
      type,
      worldPos: { x: worldPos.x, y: worldPos.y },
      screenPos: { x: e.clientX, y: e.clientY },
      button: e.button,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
    };
  }

  private handleMouseDown(e: MouseEvent): void {
    this.lastMousePos = { x: e.clientX, y: e.clientY };

    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      this.isPanning = true;
      e.preventDefault();
      return;
    }

    if (e.button === 0) {
      this.isDragging = true;
      this.emit('click', this.createEvent(e, 'click'));
    }
  }

  private handleMouseMove(e: MouseEvent): void {
    const dx = e.clientX - this.lastMousePos.x;
    const dy = e.clientY - this.lastMousePos.y;

    if (this.isPanning) {
      this.scene.pan(-dx, dy);
    }

    this.lastMousePos = { x: e.clientX, y: e.clientY };

    const event = this.createEvent(e, this.isDragging ? 'drag' : 'move');
    this.emit(this.isDragging ? 'drag' : 'move', event);
  }

  private handleMouseUp(e: MouseEvent): void {
    this.isDragging = false;
    this.isPanning = false;
    this.emit('mouseup', this.createEvent(e, 'mouseup'));
  }

  private handleDoubleClick(e: MouseEvent): void {
    this.emit('dblclick', this.createEvent(e, 'dblclick'));
  }

  private handleWheel(e: WheelEvent): void {
    e.preventDefault();

    const currentZoom = this.scene.getZoom();

    if (e.ctrlKey || e.metaKey) {
      // A trackpad pinch is delivered as a wheel event with ctrlKey set, so this
      // covers both pinch-to-zoom and cmd/ctrl + scroll.
      this.scene.zoomAt(
        currentZoom * Math.exp(-e.deltaY * PINCH_ZOOM_SENSITIVITY),
        e.clientX,
        e.clientY
      );
    } else if (e.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) {
      // Line/page deltas come from a physical mouse wheel, which keeps notch zooming.
      const zoomFactor = e.deltaY > 0 ? ZOOM_OUT_FACTOR : ZOOM_IN_FACTOR;
      this.scene.zoomAt(currentZoom * zoomFactor, e.clientX, e.clientY);
    } else {
      // Two-finger trackpad scroll pans the camera.
      this.scene.pan(e.deltaX, -e.deltaY);
    }

    const worldPos = this.scene.screenToWorld(e.clientX, e.clientY);
    const event: InputEvent = {
      type: 'wheel',
      worldPos: { x: worldPos.x, y: worldPos.y },
      screenPos: { x: e.clientX, y: e.clientY },
      button: 0,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      deltaY: e.deltaY,
    };

    this.emit('wheel', event);
  }

  private handleContextMenu(e: MouseEvent): void {
    e.preventDefault();
    this.emit('contextmenu', this.createEvent(e, 'contextmenu'));
  }

  private handleKeyDown(e: KeyboardEvent): void {
    const event: InputEvent = {
      type: 'keydown',
      worldPos: { x: 0, y: 0 },
      screenPos: { x: 0, y: 0 },
      button: 0,
      key: e.key,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
    };

    this.emit('keydown', event);
  }

  private handleKeyUp(e: KeyboardEvent): void {
    const event: InputEvent = {
      type: 'keyup',
      worldPos: { x: 0, y: 0 },
      screenPos: { x: 0, y: 0 },
      button: 0,
      key: e.key,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
    };

    this.emit('keyup', event);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.handleKeyDown.bind(this));
    window.removeEventListener('keyup', this.handleKeyUp.bind(this));
  }
}
