import { describe, it, expect, beforeEach } from 'vitest';
import type { EditorDocument } from '../../../src/types/document';
import type {
  AxisLock,
  DragUpdateContext,
  IDragOperation,
  InputModifiers,
  SelectionState,
} from '../../../src/types/interaction';
import type { EditorCommand } from '../../../src/types/command';
import type { Vector2 } from '../../../src/types/geometry';
import { SnapController } from '../../../src/controllers/SnapController';
import { WallDragOperation } from '../../../src/interactions/operations/WallDragOperation';
import { DoorDragOperation } from '../../../src/interactions/operations/DoorDragOperation';
import { UnifiedDragOperation } from '../../../src/interactions/operations/UnifiedDragOperation';
import { ObstacleDragOperation } from '../../../src/interactions/operations/ObstacleDragOperation';
import { ObstacleVertexDragOperation } from '../../../src/interactions/operations/ObstacleVertexDragOperation';
import { GrabModeDragOperation } from '../../../src/interactions/operations/GrabModeDragOperation';
import { applyCommand } from '../../../src/commands';
import { makeDoor, makeLight, makeObstacle, rectWalls, squareRoom } from '../../helpers/documents';

/**
 * Per drag kind: a `(pointer sequence) => command` table.
 *
 * These run with no store: the operation reads the document through its config getters and
 * returns a candidate command, which is the whole of what a drag does.
 */

const NO_MODIFIERS: InputModifiers = { shiftKey: false, ctrlKey: false, altKey: false };
const SHIFT: InputModifiers = { ...NO_MODIFIERS, shiftKey: true };

let doc: EditorDocument;
let guides: unknown[] = [];
let gridSnapEnabled = false;

const callbacks = {
  onSetSnapGuides: (g: unknown[]) => {
    guides = g;
  },
};

const emptySelection = (): SelectionState => ({
  selectedVertexIndices: new Set(),
  selectedLightIds: new Set(),
  selectedWallId: null,
  selectedDoorId: null,
  selectedObstacleId: null,
  selectedObstacleVertexIndices: new Set(),
});

const roomConfig = () => ({
  snapController: new SnapController(),
  getGridSnapEnabled: () => gridSnapEnabled,
  getGridSize: () => 1,
  getVertices: () => doc.geometry.boundary.walls.map((w) => ({ ...w.start })),
  getWalls: () => doc.geometry.boundary.walls,
  getWallById: (id: string) => doc.geometry.boundary.walls.find((w) => w.id === id),
  getLights: () => doc.lights,
  getDoors: () => doc.geometry.doors,
  getDoorById: (id: string) => doc.geometry.doors.find((d) => d.id === id),
  getDoorsByWallId: (wallId: string) => doc.geometry.doors.filter((d) => d.wallId === wallId),
  isRoomClosed: () => doc.geometry.boundary.isClosed,
  getRoomVertices: () => doc.geometry.boundary.walls.map((w) => ({ ...w.start })),
});

/**
 * Feed a pointer sequence through an operation. Each frame previews its command against the
 * committed document, exactly as the store does, so later frames see what the user sees.
 */
function drag(
  operation: IDragOperation,
  start: Vector2,
  frames: Array<{ position: Vector2; modifiers?: InputModifiers; axisLock?: AxisLock }>,
  selection: SelectionState = emptySelection()
): EditorCommand | null {
  operation.start({ position: start, modifiers: NO_MODIFIERS, document: doc, selection });

  let last: EditorCommand | null = null;
  for (const frame of frames) {
    const context: DragUpdateContext = {
      position: frame.position,
      modifiers: frame.modifiers ?? NO_MODIFIERS,
      axisLock: frame.axisLock ?? 'none',
    };
    const command = operation.update(context);
    if (command) last = command;
  }
  return last;
}

beforeEach(() => {
  guides = [];
  gridSnapEnabled = false;
  doc = squareRoom({
    doors: [makeDoor('door-1', 'wall-1', 3)],
    obstacles: [makeObstacle('obs-1', { x: 2, y: 2 }, 2)],
    lights: [makeLight('light-1', { x: 5, y: 5 })],
  });
});

describe('WallDragOperation', () => {
  function wallDrag(): WallDragOperation {
    const op = new WallDragOperation(roomConfig(), callbacks);
    op.setWallId('wall-1');
    return op;
  }

  it('translates the wall by the pointer delta', () => {
    const command = drag(wallDrag(), { x: 5, y: 0 }, [{ position: { x: 8, y: -3 } }]);
    expect(command).toEqual({
      type: 'wall.move',
      wallId: 'wall-1',
      start: { x: 3, y: -3 },
      end: { x: 13, y: -3 },
    });
  });

  it('axis-locked to x keeps the wall on its original y', () => {
    const command = drag(wallDrag(), { x: 5, y: 0 }, [
      { position: { x: 8, y: -3 }, axisLock: 'x' },
    ]);
    expect(command).toEqual({
      type: 'wall.move',
      wallId: 'wall-1',
      start: { x: 3, y: 0 },
      end: { x: 13, y: 0 },
    });
  });

  it('axis-locked to y keeps the wall on its original x', () => {
    const command = drag(wallDrag(), { x: 5, y: 0 }, [
      { position: { x: 8, y: -3 }, axisLock: 'y' },
    ]);
    expect(command).toEqual({
      type: 'wall.move',
      wallId: 'wall-1',
      start: { x: 0, y: -3 },
      end: { x: 10, y: -3 },
    });
  });

  it('shift snaps the wall onto a non-adjacent vertex and shows a guide', () => {
    // wall-1 runs along y=0; nudging it to y=9.8 with shift snaps to the y=10 vertices
    const command = drag(wallDrag(), { x: 5, y: 0 }, [
      { position: { x: 5, y: 9.8 }, modifiers: SHIFT },
    ]);
    expect(command).toEqual({
      type: 'wall.move',
      wallId: 'wall-1',
      start: { x: 0, y: 10 },
      end: { x: 10, y: 10 },
    });
    expect(guides.length).toBeGreaterThan(0);
  });

  it('a drag ending at its origin produces the wall it started from', () => {
    const command = drag(wallDrag(), { x: 5, y: 0 }, [
      { position: { x: 8, y: 3 } },
      { position: { x: 5, y: 0 } },
    ]);
    expect(command).toEqual({
      type: 'wall.move',
      wallId: 'wall-1',
      start: { x: 0, y: 0 },
      end: { x: 10, y: 0 },
    });
    expect(applyCommand(doc, command!)).toEqual(doc);
  });
});

describe('UnifiedDragOperation', () => {
  function unifiedDrag(vertexIndices: number[], lightIds: string[], anchorVertex: number | null) {
    const op = new UnifiedDragOperation(roomConfig(), callbacks);
    op.setAnchor(anchorVertex, anchorVertex === null ? (lightIds[0] ?? null) : null);
    const selection: SelectionState = {
      ...emptySelection(),
      selectedVertexIndices: new Set(vertexIndices),
      selectedLightIds: new Set(lightIds),
    };
    return { op, selection };
  }

  it('a single vertex drag is a single vertex.move', () => {
    const { op, selection } = unifiedDrag([0], [], 0);
    const command = drag(op, { x: 0, y: 0 }, [{ position: { x: 2, y: 3 } }], selection);
    expect(command).toEqual({ type: 'vertex.move', index: 0, position: { x: 2, y: 3 } });
  });

  it('axis lock constrains the moved vertex', () => {
    const { op, selection } = unifiedDrag([0], [], 0);
    const command = drag(
      op,
      { x: 0, y: 0 },
      [{ position: { x: 2, y: 3 }, axisLock: 'y' }],
      selection
    );
    expect(command).toEqual({ type: 'vertex.move', index: 0, position: { x: 0, y: 3 } });
  });

  it('grid snap rounds the target to the grid', () => {
    gridSnapEnabled = true;
    const { op, selection } = unifiedDrag([0], [], 0);
    const command = drag(op, { x: 0, y: 0 }, [{ position: { x: 2.4, y: 2.6 } }], selection);
    expect(command).toEqual({ type: 'vertex.move', index: 0, position: { x: 2, y: 3 } });
  });

  it('shift aligns a single vertex to another vertex', () => {
    const { op, selection } = unifiedDrag([0], [], 0);
    const command = drag(
      op,
      { x: 0, y: 0 },
      [{ position: { x: 9.7, y: 4 }, modifiers: SHIFT }],
      selection
    );
    expect(command).toEqual({ type: 'vertex.move', index: 0, position: { x: 10, y: 4 } });
    expect(guides.length).toBeGreaterThan(0);
  });

  it('a heterogeneous selection produces one compound command', () => {
    const { op, selection } = unifiedDrag([0, 1], ['light-1'], 0);
    const command = drag(op, { x: 0, y: 0 }, [{ position: { x: 1, y: 1 } }], selection);
    expect(command).toEqual({
      type: 'compound',
      label: 'Move selection',
      commands: [
        { type: 'vertex.move', index: 0, position: { x: 1, y: 1 } },
        { type: 'vertex.move', index: 1, position: { x: 11, y: 1 } },
        { type: 'light.move', lightId: 'light-1', position: { x: 6, y: 6 } },
      ],
    });
  });

  it('a light that would leave a closed room is left out of the command', () => {
    const { op, selection } = unifiedDrag([], ['light-1'], null);
    const command = drag(op, { x: 5, y: 5 }, [{ position: { x: 40, y: 40 } }], selection);
    expect(command).toBeNull();
  });
});

describe('DoorDragOperation', () => {
  it('resolves the pointer to an absolute offset along the wall', () => {
    const op = new DoorDragOperation(roomConfig());
    op.setDoorId('door-1');
    const command = drag(op, { x: 3, y: 0 }, [{ position: { x: 6, y: 0.2 } }]);
    expect(command).toEqual({ type: 'door.move', doorId: 'door-1', offset: 6 });
  });

  it('clamps the door inside the wall', () => {
    const op = new DoorDragOperation(roomConfig());
    op.setDoorId('door-1');
    const command = drag(op, { x: 3, y: 0 }, [{ position: { x: 40, y: 0 } }]) as {
      offset: number;
    } | null;
    expect(command!.offset).toBeLessThanOrEqual(10);
  });
});

describe('ObstacleDragOperation', () => {
  function obstacleDrag(): ObstacleDragOperation {
    const op = new ObstacleDragOperation(roomConfig(), callbacks);
    op.setObstacleId('obs-1');
    op.setObstacleVertices(doc.geometry.obstacles[0].walls.map((w) => ({ ...w.start })));
    return op;
  }

  it('moves every vertex by the pointer delta', () => {
    const command = drag(obstacleDrag(), { x: 3, y: 3 }, [{ position: { x: 4, y: 5 } }]);
    expect(command).toEqual({
      type: 'obstacle.move',
      obstacleId: 'obs-1',
      vertices: [
        { x: 3, y: 4 },
        { x: 5, y: 4 },
        { x: 5, y: 6 },
        { x: 3, y: 6 },
      ],
    });
  });

  it('axis lock constrains the whole obstacle', () => {
    const command = drag(obstacleDrag(), { x: 3, y: 3 }, [
      { position: { x: 4, y: 5 }, axisLock: 'x' },
    ]) as { vertices: Vector2[] };
    expect(command.vertices[0]).toEqual({ x: 3, y: 2 });
  });

  it('grid snap rounds the delta', () => {
    gridSnapEnabled = true;
    const command = drag(obstacleDrag(), { x: 3, y: 3 }, [{ position: { x: 4.4, y: 3.4 } }]) as {
      vertices: Vector2[];
    };
    expect(command.vertices[0]).toEqual({ x: 3, y: 2 });
  });

  it('shift snaps the obstacle onto a room vertex and shows guides', () => {
    // moving the obstacle so its lower-left corner lands near the room origin
    const command = drag(obstacleDrag(), { x: 3, y: 3 }, [
      { position: { x: 1.2, y: 1.1 }, modifiers: SHIFT },
    ]) as { vertices: Vector2[] };
    expect(command.vertices[0]).toEqual({ x: 0, y: 0 });
    expect(guides.length).toBeGreaterThan(0);
  });
});

describe('ObstacleVertexDragOperation', () => {
  function obstacleVertexDrag(indices: number[], anchor: number) {
    const op = new ObstacleVertexDragOperation(roomConfig(), callbacks);
    op.setObstacleId('obs-1');
    op.setAnchorVertex(anchor);
    op.setObstacleVertices(doc.geometry.obstacles[0].walls.map((w) => ({ ...w.start })));
    const selection: SelectionState = {
      ...emptySelection(),
      selectedObstacleId: 'obs-1',
      selectedObstacleVertexIndices: new Set(indices),
    };
    return { op, selection };
  }

  it('one selected vertex is one obstacle.vertex.move', () => {
    const { op, selection } = obstacleVertexDrag([0], 0);
    const command = drag(op, { x: 2, y: 2 }, [{ position: { x: 1, y: 1 } }], selection);
    expect(command).toEqual({
      type: 'obstacle.vertex.move',
      obstacleId: 'obs-1',
      index: 0,
      position: { x: 1, y: 1 },
    });
  });

  it('two selected vertices produce one compound command', () => {
    const { op, selection } = obstacleVertexDrag([0, 1], 0);
    const command = drag(op, { x: 2, y: 2 }, [{ position: { x: 1, y: 1 } }], selection);
    expect(command).toEqual({
      type: 'compound',
      label: 'Move obstacle vertices',
      commands: [
        {
          type: 'obstacle.vertex.move',
          obstacleId: 'obs-1',
          index: 0,
          position: { x: 1, y: 1 },
        },
        {
          type: 'obstacle.vertex.move',
          obstacleId: 'obs-1',
          index: 1,
          position: { x: 3, y: 1 },
        },
      ],
    });
  });

  it('axis lock constrains the dragged vertex', () => {
    const { op, selection } = obstacleVertexDrag([0], 0);
    const command = drag(
      op,
      { x: 2, y: 2 },
      [{ position: { x: 1, y: 1 }, axisLock: 'x' }],
      selection
    ) as { position: Vector2 };
    expect(command.position).toEqual({ x: 1, y: 2 });
  });

  it('grid snap rounds the vertex', () => {
    gridSnapEnabled = true;
    const { op, selection } = obstacleVertexDrag([0], 0);
    const command = drag(op, { x: 2, y: 2 }, [{ position: { x: 0.6, y: 1.4 } }], selection) as {
      position: Vector2;
    };
    expect(command.position).toEqual({ x: 1, y: 1 });
  });

  it('shift aligns to another vertex of the same obstacle', () => {
    const { op, selection } = obstacleVertexDrag([0], 0);
    const command = drag(
      op,
      { x: 2, y: 2 },
      [{ position: { x: 3.8, y: 1 }, modifiers: SHIFT }],
      selection
    ) as { position: Vector2 };
    expect(command.position).toEqual({ x: 4, y: 1 });
    expect(guides.length).toBeGreaterThan(0);
  });
});

describe('GrabModeDragOperation', () => {
  let mousePos: Vector2 = { x: 0, y: 0 };

  function grab(selection: SelectionState) {
    const op = new GrabModeDragOperation(
      { ...roomConfig(), getCurrentMousePos: () => mousePos },
      callbacks
    );
    return { op, selection };
  }

  it('a wall-only selection produces wall.move', () => {
    mousePos = { x: 0, y: 0 };
    const { op, selection } = grab({ ...emptySelection(), selectedWallId: 'wall-1' });
    const command = drag(op, { x: 0, y: 0 }, [{ position: { x: 0, y: -2 } }], selection);
    expect(command).toEqual({
      type: 'wall.move',
      wallId: 'wall-1',
      start: { x: 0, y: -2 },
      end: { x: 10, y: -2 },
    });
  });

  it('a door-only selection produces door.move', () => {
    mousePos = { x: 3, y: 0 };
    const { op, selection } = grab({ ...emptySelection(), selectedDoorId: 'door-1' });
    const command = drag(op, { x: 3, y: 0 }, [{ position: { x: 5, y: 0 } }], selection);
    expect(command).toEqual({ type: 'door.move', doorId: 'door-1', offset: 5 });
  });

  it('a mixed vertex + light selection produces one compound command', () => {
    mousePos = { x: 0, y: 0 };
    const { op, selection } = grab({
      ...emptySelection(),
      selectedVertexIndices: new Set([0]),
      selectedLightIds: new Set(['light-1']),
    });
    const command = drag(op, { x: 0, y: 0 }, [{ position: { x: 1, y: 1 } }], selection);
    expect(command).toEqual({
      type: 'compound',
      label: 'Move selection',
      commands: [
        { type: 'vertex.move', index: 0, position: { x: 1, y: 1 } },
        { type: 'light.move', lightId: 'light-1', position: { x: 6, y: 6 } },
      ],
    });
  });

  it('axis lock applies to a grabbed vertex', () => {
    mousePos = { x: 0, y: 0 };
    const { op, selection } = grab({
      ...emptySelection(),
      selectedVertexIndices: new Set([0]),
    });
    const command = drag(
      op,
      { x: 0, y: 0 },
      [{ position: { x: 2, y: 3 }, axisLock: 'x' }],
      selection
    );
    expect(command).toEqual({ type: 'vertex.move', index: 0, position: { x: 2, y: 0 } });
  });

  it('preserves the grab offset between mouse and anchor', () => {
    // Grab starts with the mouse two feet away from the vertex it is moving
    mousePos = { x: 2, y: 0 };
    const { op, selection } = grab({
      ...emptySelection(),
      selectedVertexIndices: new Set([0]),
    });
    const command = drag(op, { x: 2, y: 0 }, [{ position: { x: 6, y: 0 } }], selection);
    expect(command).toEqual({ type: 'vertex.move', index: 0, position: { x: 4, y: 0 } });
  });
});

describe('operations write nothing', () => {
  it('finish() leaves the document untouched', () => {
    const snapshot = structuredClone(doc);
    const op = new WallDragOperation(roomConfig(), callbacks);
    op.setWallId('wall-1');
    drag(op, { x: 5, y: 0 }, [{ position: { x: 5, y: 4 } }]);
    op.finish();
    expect(doc).toEqual(snapshot);
    expect(op.isActive()).toBe(false);
  });

  it('an inactive operation returns no command', () => {
    const op = new WallDragOperation(roomConfig(), callbacks);
    op.setWallId('wall-1');
    expect(op.update({ position: { x: 1, y: 1 }, modifiers: NO_MODIFIERS, axisLock: 'none' })).toBe(
      null
    );
  });
});

describe('walls fixture sanity', () => {
  it('the shared square room is the expected rectangle', () => {
    expect(rectWalls(10, 10).map((w) => w.id)).toEqual(['wall-1', 'wall-2', 'wall-3', 'wall-4']);
  });
});
