import * as THREE from 'three';
import type { Vector2, UnitFormat } from '../types';
import { formatDegrees, formatImperial } from '../utils/format';
import { clearGroup, createTextSprite, createThickLine } from '../utils/three';
import {
  Z_LAYERS,
  GEOMETRY,
  DASH_PATTERNS,
  PREVIEW_COLORS,
  LABEL_SCALE,
} from '../constants/rendering';

interface MeasurementColors {
  main: number;
  xComponent: number;
  yComponent: number;
}

/** Halo color and strength, shared by every measurement line and marker. */
const MEASUREMENT_OUTLINE_COLOR = 0x000000;
const MEASUREMENT_OUTLINE_OPACITY = 0.55;

const DEFAULT_COLORS: MeasurementColors = {
  main: 0xff00ff,
  xComponent: PREVIEW_COLORS.SNAP_GUIDE_X,
  yComponent: PREVIEW_COLORS.SNAP_GUIDE_Y,
};

/**
 * Handles rendering of measurement lines and labels.
 * Displays diagonal measurement with X/Y component breakdown.
 */
export class MeasurementRenderer {
  private group: THREE.Group;
  private colors: MeasurementColors;
  private currentUnitFormat: UnitFormat = 'feet-inches';
  private currentMeasurement: { from: Vector2; to: Vector2 } | null = null;

  constructor(parentScene: THREE.Scene, colors: MeasurementColors = DEFAULT_COLORS) {
    this.group = new THREE.Group();
    this.colors = colors;
    parentScene.add(this.group);
  }

  setUnitFormat(format: UnitFormat): void {
    if (this.currentUnitFormat !== format) {
      this.currentUnitFormat = format;
      // Re-render with new format if measurement exists
      if (this.currentMeasurement) {
        this.render(this.currentMeasurement.from, this.currentMeasurement.to);
      }
    }
  }

  /**
   * Renders a measurement line between two points.
   * Shows diagonal line, X/Y components, and distance labels.
   */
  render(from: Vector2 | null, to: Vector2 | null): void {
    this.currentMeasurement = from && to ? { from, to } : null;
    this.clear();

    if (!from || !to) return;

    const deltaX = Math.abs(to.x - from.x);
    const deltaY = Math.abs(to.y - from.y);

    this.renderDiagonalLine(from, to);
    this.renderEndpointMarkers(from, to);

    if (deltaX > 0.1) {
      this.renderXComponent(from, to, deltaX);
    }

    if (deltaY > 0.1) {
      this.renderYComponent(from, to, deltaY);
    }

    // Only the two acute angles are worth drawing — the third corner is always the
    // right angle where the X and Y components meet. A degenerate (axis-aligned)
    // measurement has no triangle at all, and its diagonal is just the one component
    // already labelled above.
    if (deltaX > 0.1 && deltaY > 0.1) {
      this.renderDiagonalLabel(from, to, deltaX, deltaY);
      this.renderAngles(from, to, deltaX, deltaY);
    }
  }

  /**
   * Draws a measurement line, with a dark halo underneath so it stays legible over light
   * flooring as well as a dark canvas. The halo goes on the base measurement layer and
   * the colored line just above it.
   */
  private addLine(
    points: Vector2[],
    color: number,
    width: number,
    dash?: { dashSize: number; gapSize: number }
  ): void {
    this.group.add(
      createThickLine(points, {
        color: MEASUREMENT_OUTLINE_COLOR,
        width: width + GEOMETRY.MEASUREMENT_OUTLINE_WIDTH * 2,
        z: Z_LAYERS.MEASUREMENT,
        dash,
        opacity: MEASUREMENT_OUTLINE_OPACITY,
      })
    );
    this.group.add(
      createThickLine(points, { color, width, z: Z_LAYERS.MEASUREMENT + 0.002, dash })
    );
  }

  private renderDiagonalLine(from: Vector2, to: Vector2): void {
    this.addLine([from, to], this.colors.main, GEOMETRY.MEASUREMENT_LINE_WIDTH);
  }

  private renderEndpointMarkers(from: Vector2, to: Vector2): void {
    for (const point of [from, to]) {
      // Halo ring, matching the one under the lines.
      const halo = new THREE.Mesh(
        new THREE.CircleGeometry(
          GEOMETRY.MEASUREMENT_MARKER_RADIUS + GEOMETRY.MEASUREMENT_OUTLINE_WIDTH,
          GEOMETRY.CIRCLE_SEGMENTS
        ),
        new THREE.MeshBasicMaterial({
          color: MEASUREMENT_OUTLINE_COLOR,
          transparent: true,
          opacity: MEASUREMENT_OUTLINE_OPACITY,
        })
      );
      halo.position.set(point.x, point.y, Z_LAYERS.MEASUREMENT + 0.008);
      this.group.add(halo);

      const geometry = new THREE.CircleGeometry(
        GEOMETRY.MEASUREMENT_MARKER_RADIUS,
        GEOMETRY.CIRCLE_SEGMENTS
      );
      const material = new THREE.MeshBasicMaterial({ color: this.colors.main });
      const marker = new THREE.Mesh(geometry, material);
      marker.position.set(point.x, point.y, Z_LAYERS.MEASUREMENT + 0.01);
      this.group.add(marker);
    }
  }

  private renderComponent(
    lineStart: Vector2,
    lineEnd: Vector2,
    labelPos: Vector2,
    distance: number,
    color: number
  ): void {
    this.addLine(
      [lineStart, lineEnd],
      color,
      GEOMETRY.MEASUREMENT_COMPONENT_WIDTH,
      DASH_PATTERNS.MEASUREMENT_COMPONENT
    );

    // Label
    const label = this.createLabel(
      formatImperial(distance, { format: this.currentUnitFormat }),
      color
    );
    label.position.set(labelPos.x, labelPos.y, Z_LAYERS.MEASUREMENT + 0.01);
    this.group.add(label);
  }

  private renderXComponent(from: Vector2, to: Vector2, deltaX: number): void {
    this.renderComponent(
      from,
      { x: to.x, y: from.y },
      { x: (from.x + to.x) / 2, y: from.y - 0.4 },
      deltaX,
      this.colors.xComponent
    );
  }

  private renderYComponent(from: Vector2, to: Vector2, deltaY: number): void {
    this.renderComponent(
      { x: to.x, y: from.y },
      to,
      { x: to.x + 0.5, y: (from.y + to.y) / 2 },
      deltaY,
      this.colors.yComponent
    );
  }

  /**
   * Labels the diagonal with its own length, at the midpoint and nudged perpendicular to
   * the line — on the side away from the right-angle corner, so it never lands on top of
   * the X/Y component labels or their angle arcs.
   */
  private renderDiagonalLabel(from: Vector2, to: Vector2, deltaX: number, deltaY: number): void {
    const distance = Math.hypot(deltaX, deltaY);
    const signedX = to.x - from.x;
    const signedY = to.y - from.y;

    // Perpendicular to the diagonal; the sign flips it to the outside of the triangle.
    const side = Math.sign(signedX * signedY);
    const offset = GEOMETRY.MEASUREMENT_LABEL_OFFSET;
    const labelX = (from.x + to.x) / 2 + (-signedY / distance) * offset * side;
    const labelY = (from.y + to.y) / 2 + (signedX / distance) * offset * side;

    const label = this.createLabel(
      formatImperial(distance, { format: this.currentUnitFormat }),
      this.colors.main
    );
    label.position.set(labelX, labelY, Z_LAYERS.MEASUREMENT + 0.01);
    this.group.add(label);
  }

  /**
   * Draws the two acute angles of the measurement triangle: at `from`, between the X
   * component and the diagonal; at `to`, between the Y component and the diagonal.
   */
  private renderAngles(from: Vector2, to: Vector2, deltaX: number, deltaY: number): void {
    const hypotenuse = Math.hypot(deltaX, deltaY);
    const angleAtFrom = Math.atan2(deltaY, deltaX);
    const angleAtTo = Math.PI / 2 - angleAtFrom;

    const signX = Math.sign(to.x - from.x);
    const signY = Math.sign(to.y - from.y);
    const alongDiagonal = { x: (to.x - from.x) / hypotenuse, y: (to.y - from.y) / hypotenuse };

    // At `from` the arc spans the X leg and the diagonal, so it must fit inside both.
    this.renderAngleArc(
      from,
      { x: signX, y: 0 },
      alongDiagonal,
      angleAtFrom,
      Math.min(deltaX, hypotenuse),
      this.colors.xComponent
    );

    // At `to` the legs run back down the Y component and back along the diagonal.
    this.renderAngleArc(
      to,
      { x: 0, y: -signY },
      { x: -alongDiagonal.x, y: -alongDiagonal.y },
      angleAtTo,
      Math.min(deltaY, hypotenuse),
      this.colors.yComponent
    );
  }

  /**
   * Renders an arc sweeping from `startDir` to `endDir` around `corner`, labelled with
   * the angle in degrees. `legLength` is the shortest side touching the corner — the
   * radius shrinks to stay inside it so the arc never overshoots the triangle.
   */
  private renderAngleArc(
    corner: Vector2,
    startDir: Vector2,
    endDir: Vector2,
    angle: number,
    legLength: number,
    color: number
  ): void {
    const radius = Math.min(GEOMETRY.MEASUREMENT_ANGLE_RADIUS, legLength * 0.35);
    const startAngle = Math.atan2(startDir.y, startDir.x);
    const endAngle = Math.atan2(endDir.y, endDir.x);

    // Sweep the short way around, so the arc lands inside the triangle rather than outside it.
    let sweep = endAngle - startAngle;
    while (sweep > Math.PI) sweep -= 2 * Math.PI;
    while (sweep < -Math.PI) sweep += 2 * Math.PI;

    const points: Vector2[] = [];
    for (let i = 0; i <= GEOMETRY.ARC_SEGMENTS; i++) {
      const theta = startAngle + (sweep * i) / GEOMETRY.ARC_SEGMENTS;
      points.push({
        x: corner.x + Math.cos(theta) * radius,
        y: corner.y + Math.sin(theta) * radius,
      });
    }
    this.addLine(points, color, GEOMETRY.MEASUREMENT_ANGLE_WIDTH);

    // Label sits just outside the arc, on the bisector.
    const bisector = startAngle + sweep / 2;
    const labelRadius = radius + LABEL_SCALE.MEASUREMENT_ANGLE_LABEL;
    const label = createTextSprite(`${formatDegrees(angle)}°`, {
      fontSize: 20,
      padding: 6,
      fontWeight: 'bold',
      backgroundColor: color,
      textColor: 'white',
      scale: LABEL_SCALE.MEASUREMENT_ANGLE_LABEL,
    });
    label.position.set(
      corner.x + Math.cos(bisector) * labelRadius,
      corner.y + Math.sin(bisector) * labelRadius,
      Z_LAYERS.MEASUREMENT + 0.01
    );
    this.group.add(label);
  }

  private createLabel(text: string, backgroundColor: number): THREE.Sprite {
    return createTextSprite(text, {
      fontSize: 20,
      padding: 6,
      fontWeight: 'bold',
      backgroundColor,
      textColor: 'white',
      scale: LABEL_SCALE.MEASUREMENT_LABEL,
    });
  }

  /**
   * Clears all measurement visuals.
   */
  clear(): void {
    clearGroup(this.group);
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  dispose(): void {
    this.clear();
    this.group.parent?.remove(this.group);
  }
}
