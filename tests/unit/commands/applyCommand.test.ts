import { describe, it, expect } from 'vitest';
import type { EditorCommand, CommandType } from '../../../src/types/command';
import type { EditorDocument } from '../../../src/types/document';
import { MOVE_AND_SET_COMMAND_TYPES } from '../../../src/types/command';
import { applyCommand, commandLabel, registeredCommandTypes } from '../../../src/commands';
import { valueEqual } from '../../../src/commands/serializable';
import { DEFAULT_DISPLAY_PREFERENCES, DEFAULT_RAFTER_CONFIG } from '../../../src/types/state';
import {
  makeDocument,
  makeDoor,
  makeLight,
  makeObstacle,
  obstacleVertices,
  rectWalls,
  squareRoom,
} from '../../helpers/documents';

/**
 * The pure command table: `(document, command) => document`.
 * No store, no Svelte, no DOM anywhere in this file.
 */

interface Case {
  name: string;
  type: CommandType;
  before: () => EditorDocument;
  command: EditorCommand;
  expect: (next: EditorDocument, before: EditorDocument) => void;
}

const roomWithEverything = (): EditorDocument =>
  squareRoom({
    doors: [makeDoor('door-1', 'wall-1', 3)],
    obstacles: [makeObstacle('obs-1', { x: 2, y: 2 }, 2)],
    lights: [makeLight('light-1', { x: 5, y: 5 })],
  });

const cases: Case[] = [
  {
    name: 'wall.move translates the wall and drags both neighbours with it',
    type: 'wall.move',
    before: squareRoom,
    command: {
      type: 'wall.move',
      wallId: 'wall-1',
      start: { x: 0, y: -2 },
      end: { x: 10, y: -2 },
    },
    expect: (next) => {
      const walls = next.geometry.boundary.walls;
      expect(walls[0].start).toEqual({ x: 0, y: -2 });
      expect(walls[0].end).toEqual({ x: 10, y: -2 });
      // previous wall (index 3) ends at the new start
      expect(walls[3].end).toEqual({ x: 0, y: -2 });
      expect(walls[3].length).toBeCloseTo(12);
      // next wall (index 1) starts at the new end
      expect(walls[1].start).toEqual({ x: 10, y: -2 });
      expect(walls[1].length).toBeCloseTo(12);
    },
  },
  {
    name: 'wall.move on an unknown wall is a no-op',
    type: 'wall.move',
    before: squareRoom,
    command: { type: 'wall.move', wallId: 'nope', start: { x: 0, y: 0 }, end: { x: 1, y: 1 } },
    expect: (next, before) => expect(next).toBe(before),
  },
  {
    name: 'wall.setLength moves the end point along the wall direction',
    type: 'wall.setLength',
    before: squareRoom,
    command: { type: 'wall.setLength', wallId: 'wall-1', length: 5 },
    expect: (next) => {
      const walls = next.geometry.boundary.walls;
      expect(walls[0].end).toEqual({ x: 5, y: 0 });
      expect(walls[0].length).toBe(5);
      expect(walls[1].start).toEqual({ x: 5, y: 0 });
      expect(walls[1].length).toBeCloseTo(Math.hypot(5, 10));
    },
  },
  {
    name: 'vertex.move updates the two walls that meet at the vertex',
    type: 'vertex.move',
    before: squareRoom,
    command: { type: 'vertex.move', index: 1, position: { x: 12, y: 1 } },
    expect: (next) => {
      const walls = next.geometry.boundary.walls;
      expect(walls[1].start).toEqual({ x: 12, y: 1 });
      expect(walls[0].end).toEqual({ x: 12, y: 1 });
      expect(walls[0].length).toBeCloseTo(Math.hypot(12, 1));
    },
  },
  {
    name: 'vertex.move out of range is a no-op',
    type: 'vertex.move',
    before: squareRoom,
    command: { type: 'vertex.move', index: 99, position: { x: 0, y: 0 } },
    expect: (next, before) => expect(next).toBe(before),
  },
  {
    name: 'vertex.insert splits the wall in two',
    type: 'vertex.insert',
    before: squareRoom,
    command: { type: 'vertex.insert', wallId: 'wall-1', position: { x: 5, y: 0 } },
    expect: (next) => {
      const walls = next.geometry.boundary.walls;
      expect(walls).toHaveLength(5);
      expect(walls[0].end).toEqual({ x: 5, y: 0 });
      expect(walls[1].start).toEqual({ x: 5, y: 0 });
      expect(walls[0].length).toBe(5);
      expect(walls[1].length).toBe(5);
    },
  },
  {
    name: 'vertex.delete merges the two walls and drops doors on the removed wall',
    type: 'vertex.delete',
    before: () =>
      squareRoom({
        walls: [
          ...rectWalls(10, 10),
          { id: 'wall-5', start: { x: 0, y: 5 }, end: { x: 0, y: 0 }, length: 5 },
        ],
        doors: [makeDoor('door-1', 'wall-5', 1), makeDoor('door-2', 'wall-2', 1)],
      }),
    command: { type: 'vertex.delete', index: 4 },
    expect: (next) => {
      expect(next.geometry.boundary.walls).toHaveLength(4);
      expect(next.geometry.doors.map((d) => d.id)).toEqual(['door-2']);
    },
  },
  {
    name: 'vertex.delete refuses to go below a triangle',
    type: 'vertex.delete',
    before: () =>
      makeDocument({
        isClosed: true,
        walls: [
          { id: 'a', start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, length: 10 },
          { id: 'b', start: { x: 10, y: 0 }, end: { x: 5, y: 10 }, length: 11.18 },
          { id: 'c', start: { x: 5, y: 10 }, end: { x: 0, y: 0 }, length: 11.18 },
        ],
      }),
    command: { type: 'vertex.delete', index: 0 },
    expect: (next, before) => expect(next).toBe(before),
  },
  {
    name: 'room.close replaces the boundary and marks it closed',
    type: 'room.close',
    before: makeDocument,
    command: { type: 'room.close', walls: rectWalls(4, 4) },
    expect: (next) => {
      expect(next.geometry.boundary.isClosed).toBe(true);
      expect(next.geometry.boundary.walls).toHaveLength(4);
    },
  },
  {
    name: 'door.add appends the door',
    type: 'door.add',
    before: squareRoom,
    command: { type: 'door.add', door: makeDoor('door-9', 'wall-1', 2) },
    expect: (next) => expect(next.geometry.doors.map((d) => d.id)).toEqual(['door-9']),
  },
  {
    name: 'door.move sets the absolute offset along the wall',
    type: 'door.move',
    before: roomWithEverything,
    command: { type: 'door.move', doorId: 'door-1', offset: 7 },
    expect: (next) => expect(next.geometry.doors[0].position).toBe(7),
  },
  {
    name: 'door.set applies the given fields only',
    type: 'door.set',
    before: roomWithEverything,
    command: { type: 'door.set', doorId: 'door-1', changes: { width: 2.5 } },
    expect: (next) => {
      expect(next.geometry.doors[0].width).toBe(2.5);
      expect(next.geometry.doors[0].position).toBe(3);
    },
  },
  {
    name: 'door.remove drops the door',
    type: 'door.remove',
    before: roomWithEverything,
    command: { type: 'door.remove', doorId: 'door-1' },
    expect: (next) => expect(next.geometry.doors).toHaveLength(0),
  },
  {
    name: 'obstacle.add appends the obstacle',
    type: 'obstacle.add',
    before: squareRoom,
    command: { type: 'obstacle.add', obstacle: makeObstacle('obs-9', { x: 1, y: 1 }, 2) },
    expect: (next) => expect(next.geometry.obstacles.map((o) => o.id)).toEqual(['obs-9']),
  },
  {
    name: 'obstacle.move sets every vertex absolutely and recomputes lengths',
    type: 'obstacle.move',
    before: roomWithEverything,
    command: {
      type: 'obstacle.move',
      obstacleId: 'obs-1',
      vertices: [
        { x: 5, y: 5 },
        { x: 7, y: 5 },
        { x: 7, y: 7 },
        { x: 5, y: 7 },
      ],
    },
    expect: (next) => {
      expect(obstacleVertices(next, 'obs-1')).toEqual([
        { x: 5, y: 5 },
        { x: 7, y: 5 },
        { x: 7, y: 7 },
        { x: 5, y: 7 },
      ]);
      for (const wall of next.geometry.obstacles[0].walls) {
        expect(wall.length).toBeCloseTo(2);
      }
    },
  },
  {
    name: 'obstacle.move with the wrong vertex count is a no-op',
    type: 'obstacle.move',
    before: roomWithEverything,
    command: { type: 'obstacle.move', obstacleId: 'obs-1', vertices: [{ x: 0, y: 0 }] },
    expect: (next, before) => expect(next).toBe(before),
  },
  {
    name: 'obstacle.vertex.move moves one corner and its two edges',
    type: 'obstacle.vertex.move',
    before: roomWithEverything,
    command: {
      type: 'obstacle.vertex.move',
      obstacleId: 'obs-1',
      index: 0,
      position: { x: 1, y: 1 },
    },
    expect: (next) => {
      const verts = obstacleVertices(next, 'obs-1');
      expect(verts[0]).toEqual({ x: 1, y: 1 });
      expect(verts[1]).toEqual({ x: 4, y: 2 });
    },
  },
  {
    name: 'obstacle.set applies the given fields only',
    type: 'obstacle.set',
    before: roomWithEverything,
    command: { type: 'obstacle.set', obstacleId: 'obs-1', changes: { height: 4.5 } },
    expect: (next) => expect(next.geometry.obstacles[0].height).toBe(4.5),
  },
  {
    name: 'obstacle.remove drops the obstacle',
    type: 'obstacle.remove',
    before: roomWithEverything,
    command: { type: 'obstacle.remove', obstacleId: 'obs-1' },
    expect: (next) => expect(next.geometry.obstacles).toHaveLength(0),
  },
  {
    name: 'space.setCeilingHeight sets an absolute height',
    type: 'space.setCeilingHeight',
    before: squareRoom,
    command: { type: 'space.setCeilingHeight', height: 12 },
    expect: (next) => expect(next.space.ceilingHeight).toBe(12),
  },
  {
    name: 'document.setDisplayPreferences replaces the whole block',
    type: 'document.setDisplayPreferences',
    before: squareRoom,
    command: {
      type: 'document.setDisplayPreferences',
      preferences: { ...DEFAULT_DISPLAY_PREFERENCES, gridSnapEnabled: true },
    },
    expect: (next) => expect(next.displayPreferences?.gridSnapEnabled).toBe(true),
  },
  {
    name: 'light.add appends the fixture',
    type: 'light.add',
    before: squareRoom,
    command: { type: 'light.add', light: makeLight('light-9', { x: 1, y: 1 }) },
    expect: (next) => expect(next.lights.map((l) => l.id)).toEqual(['light-9']),
  },
  {
    name: 'light.move sets an absolute position',
    type: 'light.move',
    before: roomWithEverything,
    command: { type: 'light.move', lightId: 'light-1', position: { x: 2, y: 8 } },
    expect: (next) => expect(next.lights[0].position).toEqual({ x: 2, y: 8 }),
  },
  {
    name: 'light.set applies the given fields only',
    type: 'light.set',
    before: roomWithEverything,
    command: {
      type: 'light.set',
      lightId: 'light-1',
      changes: { definitionId: 'led-flood' },
    },
    expect: (next) => {
      expect(next.lights[0].definitionId).toBe('led-flood');
      expect(next.lights[0].position).toEqual({ x: 5, y: 5 });
    },
  },
  {
    name: 'light.remove drops the fixture',
    type: 'light.remove',
    before: roomWithEverything,
    command: { type: 'light.remove', lightId: 'light-1' },
    expect: (next) => expect(next.lights).toHaveLength(0),
  },
  {
    name: 'lighting.setRafterConfig replaces the config',
    type: 'lighting.setRafterConfig',
    before: squareRoom,
    command: {
      type: 'lighting.setRafterConfig',
      config: { ...DEFAULT_RAFTER_CONFIG, visible: true },
    },
    expect: (next) => expect(next.rafterConfig?.visible).toBe(true),
  },
  {
    name: 'compound applies its members in order',
    type: 'compound',
    before: squareRoom,
    command: {
      type: 'compound',
      label: 'Move two vertices',
      commands: [
        { type: 'vertex.move', index: 0, position: { x: -1, y: -1 } },
        { type: 'vertex.move', index: 1, position: { x: 11, y: -1 } },
      ],
    },
    expect: (next) => {
      const walls = next.geometry.boundary.walls;
      expect(walls[0].start).toEqual({ x: -1, y: -1 });
      expect(walls[0].end).toEqual({ x: 11, y: -1 });
    },
  },
];

describe('applyCommand table', () => {
  for (const testCase of cases) {
    it(testCase.name, () => {
      const before = testCase.before();
      const snapshot = structuredClone(before);

      const next = applyCommand(before, testCase.command);

      testCase.expect(next, before);
      // Handlers are pure: the input document is never mutated
      expect(before).toEqual(snapshot);
    });
  }

  it('covers every registered command type', () => {
    const covered = new Set(cases.map((c) => c.type));
    expect([...registeredCommandTypes].filter((t) => !covered.has(t))).toEqual([]);
  });

  it('throws on an unregistered command type', () => {
    expect(() => applyCommand(squareRoom(), { type: 'nope' } as unknown as EditorCommand)).toThrow(
      /No handler registered/
    );
  });

  it('every command has a label', () => {
    for (const testCase of cases) {
      expect(commandLabel(testCase.command).length).toBeGreaterThan(0);
    }
  });
});

describe('every dispatched command survives a JSON round-trip value-identically', () => {
  for (const testCase of cases) {
    it(testCase.name, () => {
      const roundTripped = JSON.parse(JSON.stringify(testCase.command)) as EditorCommand;
      expect(valueEqual(roundTripped, testCase.command)).toBe(true);

      // and applying the round-tripped value produces the same document.
      // Ids are masked because `vertex.insert` mints fresh ones for the split walls.
      const maskIds = (doc: EditorDocument) =>
        JSON.parse(JSON.stringify(doc, (key, value) => (key === 'id' ? '<id>' : value)));

      expect(maskIds(applyCommand(testCase.before(), roundTripped))).toEqual(
        maskIds(applyCommand(testCase.before(), testCase.command))
      );
    });
  }
});

describe('the move and set family is idempotent', () => {
  const moveAndSetCases = cases.filter((c) => MOVE_AND_SET_COMMAND_TYPES.includes(c.type));

  it('covers every move/set command type', () => {
    const covered = new Set(moveAndSetCases.map((c) => c.type));
    expect(MOVE_AND_SET_COMMAND_TYPES.filter((t) => !covered.has(t))).toEqual([]);
  });

  for (const testCase of moveAndSetCases) {
    it(`${testCase.type}: applying twice equals applying once`, () => {
      const once = applyCommand(testCase.before(), testCase.command);
      const twice = applyCommand(once, testCase.command);
      expect(twice).toEqual(once);
    });
  }

  it('a compound of move commands is idempotent too', () => {
    const command: EditorCommand = {
      type: 'compound',
      label: 'Move selection',
      commands: [
        { type: 'vertex.move', index: 0, position: { x: -1, y: -1 } },
        { type: 'light.move', lightId: 'light-1', position: { x: 6, y: 6 } },
      ],
    };
    const once = applyCommand(roomWithEverything(), command);
    const twice = applyCommand(once, command);
    expect(twice).toEqual(once);
  });
});
