import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createDoorGraphics } from '../../../src/floorplan/rendering/editorRendering';
import type { Door, WallSegment } from '../../../src/floorplan/types';

const WALL: WallSegment = {
  id: 'wall-1',
  start: { x: 0, y: 0 },
  end: { x: 10, y: 0 },
  length: 10,
};

const DOOR: Door = {
  id: 'door-1',
  wallId: 'wall-1',
  position: 3,
  width: 3,
  swingDirection: 'right',
  swingSide: 'inside',
};

describe('createDoorGraphics', () => {
  it('builds the panel, arc, hinge, and opening', () => {
    expect(createDoorGraphics(DOOR, WALL, false)).toHaveLength(4);
  });

  it('renders every part as a mesh with real geometry', () => {
    // DoorRenderer's preview path recolors parts by assuming they are all meshes — the
    // lines are quad ribbons, since WebGL draws a THREE.Line one pixel wide regardless
    // of the material's linewidth.
    for (const part of createDoorGraphics(DOOR, WALL, false)) {
      expect(part).toBeInstanceOf(THREE.Mesh);
      const geometry = (part as THREE.Mesh).geometry;
      expect(geometry.getAttribute('position').count).toBeGreaterThan(0);
    }
  });

  it('draws the selected panel heavier than the unselected one', () => {
    const widthOfPanel = (isSelected: boolean): number => {
      const panel = createDoorGraphics(DOOR, WALL, isSelected)[0] as THREE.Mesh;
      const position = panel.geometry.getAttribute('position');
      // Panel runs perpendicular to a horizontal wall, so its width shows up in x.
      return Math.abs(position.getX(0) - position.getX(1));
    };

    expect(widthOfPanel(true)).toBeGreaterThan(widthOfPanel(false));
  });

  it('tags the panel with its door id', () => {
    expect(createDoorGraphics(DOOR, WALL, false)[0].userData.doorId).toBe('door-1');
  });

  it('returns nothing for a degenerate wall', () => {
    const degenerate: WallSegment = {
      id: 'wall-2',
      start: { x: 1, y: 1 },
      end: { x: 1, y: 1 },
      length: 0,
    };
    expect(createDoorGraphics({ ...DOOR, wallId: 'wall-2' }, degenerate, false)).toHaveLength(0);
  });
});
