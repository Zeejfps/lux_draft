import * as THREE from 'three';
import type { Vector2, WallSegment, UnitFormat, Door } from '../types';
import type { ModuleView, SceneLayer } from '../types/moduleRuntime';
import type { SnapGuide } from '../controllers/SnapController';
import { distancePointToSegment } from '../utils/math';
import { WALL_HIT_TOLERANCE_FT } from '../constants/editor';
import { createCoreLayers } from './coreLayers';
import type { DoorRenderer } from './DoorRenderer';
import { DrawingPreviewRenderer } from './DrawingPreviewRenderer';
import { OverlayRenderer } from './OverlayRenderer';
import { MeasurementRenderer } from './MeasurementRenderer';

/**
 * The 2D editor view.
 *
 * Two halves, and the split is the point of phase 4:
 *
 * - **Projections of the document** are `SceneLayer`s. Core contributes walls, doors and
 *   obstacles; the active module contributes its own through `ModuleRuntime.layers(scene)`.
 *   `render(view)` loops over both. There is no `updateLights`, no `setLightsVisible`, and no
 *   per-domain facade method left.
 * - **Gesture visuals** — the phantom line, the preview vertex, snap guides, the selection box,
 *   the measurement line and the door preview — stay imperative and stay named. They are not
 *   functions of the document, so a `SceneLayer` would have nothing to derive them from.
 */
export class EditorRenderer {
  private readonly coreLayers: SceneLayer[];
  private moduleLayers: readonly SceneLayer[] = [];
  private readonly lastInputs = new WeakMap<SceneLayer, unknown>();

  private readonly doorRenderer: DoorRenderer;
  private readonly drawingPreviewRenderer: DrawingPreviewRenderer;
  private readonly overlayRenderer: OverlayRenderer;
  private readonly measurementRenderer: MeasurementRenderer;

  constructor(scene: THREE.Scene) {
    const core = createCoreLayers(scene);
    this.coreLayers = core.layers;
    this.doorRenderer = core.doorRenderer;
    this.drawingPreviewRenderer = new DrawingPreviewRenderer(scene);
    this.overlayRenderer = new OverlayRenderer(scene);
    this.measurementRenderer = new MeasurementRenderer(scene);
  }

  // ============================================
  // Layers
  // ============================================

  /**
   * The active module's layers. The **registry** owns their disposal, not this renderer — a
   * module's contributions belong to its activation scope.
   */
  setModuleLayers(layers: readonly SceneLayer[]): void {
    this.moduleLayers = layers;
  }

  /** One pass over core and module layers. `inputs?` skips a layer whose inputs are unchanged. */
  render(view: ModuleView<unknown>): void {
    for (const layer of this.coreLayers) this.renderLayer(layer, view);
    for (const layer of this.moduleLayers) this.renderLayer(layer, view);
  }

  private renderLayer(layer: SceneLayer, view: ModuleView<unknown>): void {
    if (layer.inputs) {
      const next = layer.inputs(view);
      if (this.lastInputs.has(layer) && this.lastInputs.get(layer) === next) return;
      this.lastInputs.set(layer, next);
    }
    layer.update(view);
  }

  // ============================================
  // Wall hit testing
  // ============================================

  getWallAtPosition(
    pos: Vector2,
    walls: WallSegment[],
    tolerance: number = WALL_HIT_TOLERANCE_FT
  ): WallSegment | null {
    for (const wall of walls) {
      const dist = distancePointToSegment(pos, wall.start, wall.end);
      if (dist <= tolerance) {
        return wall;
      }
    }
    return null;
  }

  // ============================================
  // Gesture visuals
  // ============================================

  setUnitFormat(format: UnitFormat): void {
    // Layers read the unit format off the view; only the measurement overlay, which is not a
    // projection of the document, still needs telling.
    this.measurementRenderer.setUnitFormat(format);
  }

  setPhantomLine(start: Vector2 | null, end: Vector2 | null): void {
    this.drawingPreviewRenderer.setPhantomLine(start, end);
  }

  setPreviewVertex(pos: Vector2 | null): void {
    this.drawingPreviewRenderer.setPreviewVertex(pos);
  }

  updateDrawingVertices(vertices: Vector2[]): void {
    this.drawingPreviewRenderer.updateDrawingVertices(vertices);
  }

  setDoorPreview(door: Door | null, wall: WallSegment | null, canPlace: boolean = true): void {
    this.doorRenderer.setPreview(door, wall, canPlace);
  }

  clearDoorPreview(): void {
    this.doorRenderer.clearPreview();
  }

  setSnapGuides(guides: SnapGuide[]): void {
    this.overlayRenderer.setSnapGuides(guides);
  }

  setSelectionBox(start: Vector2 | null, end: Vector2 | null): void {
    this.overlayRenderer.setSelectionBox(start, end);
  }

  setMeasurementLine(from: Vector2 | null, to: Vector2 | null): void {
    this.measurementRenderer.render(from, to);
  }

  // ============================================
  // Visibility and disposal
  // ============================================

  /** A hard override, used when leaving the editor view. Layers otherwise follow `viewMode`. */
  setVisible(visible: boolean): void {
    for (const layer of this.coreLayers) layer.setVisible(visible);
    this.drawingPreviewRenderer.setVisible(visible);
    this.overlayRenderer.setVisible(visible);
    this.measurementRenderer.setVisible(visible);
  }

  dispose(): void {
    for (const layer of this.coreLayers) layer.dispose();
    this.drawingPreviewRenderer.dispose();
    this.overlayRenderer.dispose();
    this.measurementRenderer.dispose();
    this.moduleLayers = [];
  }
}
