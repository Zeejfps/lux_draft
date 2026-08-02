/**
 * The selection value itself: `defineSelection` round-trips, cross-clearing is structural
 * (a property of replacing one value, not of clearing siblings), and panel keys are derived
 * from the same `(moduleId, type)` pair that builds and matches a selection.
 */
import { describe, it, expect } from 'vitest';
import {
  CORE_MODULE_ID,
  combineSelection,
  defineSelection,
  getSelectedDoorId,
  getSelectedObstacleId,
  getSelectedObstacleVertexIndices,
  getSelectedVertexIndices,
  getSelectedWallId,
  isEmptySelection,
  NO_SELECTION,
  panelKeyOf,
  selectionPanelKeys,
  selectionParts,
  toggleMember,
  type Selection,
} from '../../../src/types/selection';
import { fixtureSelection, getSelectedFixtureIds } from '../../../src/lighting/selection';

interface Plank {
  ids: string[];
  course: number;
}

const plankSelection = defineSelection<Plank>('flooring', 'plank', (payload) => {
  if (typeof payload !== 'object' || payload === null) return null;
  const { ids, course } = payload as { ids?: unknown; course?: unknown };
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) return null;
  if (typeof course !== 'number') return null;
  return { ids: ids as string[], course };
});

describe('defineSelection', () => {
  it('round-trips: match(make(x)) is x', () => {
    const payload: Plank = { ids: ['p1', 'p2'], course: 3 };
    expect(plankSelection.match(plankSelection.make(payload))).toEqual(payload);
  });

  it('round-trips through a multi selection', () => {
    const payload: Plank = { ids: ['p1'], course: 0 };
    const selection = combineSelection([
      { kind: 'vertex', indices: [0, 1] },
      plankSelection.make(payload),
    ]);
    expect(plankSelection.match(selection)).toEqual(payload);
    expect(getSelectedVertexIndices(selection)).toEqual([0, 1]);
  });

  it('round-trips through JSON — a selection is plain data', () => {
    const made = plankSelection.make({ ids: ['p1'], course: 3 });
    const revived = JSON.parse(JSON.stringify(made)) as Selection;
    expect(revived).toEqual(made);
    expect(plankSelection.match(revived)).toEqual({ ids: ['p1'], course: 3 });
  });

  it('does not match another module or another type', () => {
    const other = defineSelection<Plank>('flooring', 'course', () => ({ ids: [], course: 0 }));
    const otherModule = defineSelection<Plank>('lighting', 'plank', () => ({ ids: [], course: 0 }));
    const made = plankSelection.make({ ids: ['p1'], course: 1 });
    expect(other.match(made)).toBeNull();
    expect(otherModule.match(made)).toBeNull();
  });

  it('rejects a payload its own parser does not accept', () => {
    const hostile: Selection = {
      kind: 'module',
      moduleId: 'flooring',
      type: 'plank',
      payload: { ids: [1, 2], course: 'three' },
    };
    expect(plankSelection.match(hostile)).toBeNull();
  });

  it('derives panelKey and the selection it makes from the same pair', () => {
    expect(plankSelection.panelKey).toBe('flooring.plank');
    expect(panelKeyOf(selectionParts(plankSelection.make({ ids: [], course: 0 }))[0])).toBe(
      plankSelection.panelKey
    );
  });

  it('refuses the core namespace', () => {
    expect(() => defineSelection('core', 'wall', () => null)).toThrow(/reserved/);
  });

  it('the lighting fixture kind is a module selection, not a core variant', () => {
    expect(fixtureSelection.panelKey).toBe('lighting.fixture');
    expect(fixtureSelection.moduleId).not.toBe(CORE_MODULE_ID);
    expect(getSelectedFixtureIds(fixtureSelection.make({ ids: ['l1', 'l2'] }))).toEqual([
      'l1',
      'l2',
    ]);
  });
});

describe('cross-clearing is structural', () => {
  const everything: Selection[] = [
    { kind: 'wall', id: 'wall-1' },
    { kind: 'vertex', indices: [0, 1] },
    { kind: 'door', id: 'door-1' },
    { kind: 'obstacle', id: 'obs-1' },
    { kind: 'obstacleVertex', obstacleId: 'obs-1', indices: [2] },
    fixtureSelection.make({ ids: ['light-1'] }),
  ];

  it.each(everything.map((s, i) => [s.kind + i, s] as const))(
    'selecting %s leaves nothing else selected',
    (_name, next) => {
      // Whatever was selected before, the new value is the whole selection.
      const readers = [
        getSelectedWallId,
        getSelectedDoorId,
        (s: Selection) => (getSelectedVertexIndices(s).length ? 'vertex' : null),
        (s: Selection) => (getSelectedFixtureIds(s).length ? 'fixture' : null),
        (s: Selection) => (getSelectedObstacleVertexIndices(s).length ? 'obsVertex' : null),
        getSelectedObstacleId,
      ];
      const live = readers.filter((read) => read(next) !== null);
      // An obstacle-vertex selection deliberately reports its obstacle too; everything else
      // lights up exactly one reader.
      expect(live.length).toBeLessThanOrEqual(next.kind === 'obstacleVertex' ? 2 : 1);
    }
  );

  it('there is no state in which a wall and a door are both selected', () => {
    let selection: Selection = { kind: 'wall', id: 'wall-1' };
    selection = { kind: 'door', id: 'door-1' };
    expect(getSelectedWallId(selection)).toBeNull();
    expect(getSelectedDoorId(selection)).toBe('door-1');
  });

  it('NO_SELECTION is empty and yields no panels', () => {
    expect(isEmptySelection(NO_SELECTION)).toBe(true);
    expect(selectionPanelKeys(NO_SELECTION)).toEqual([]);
  });
});

describe('combineSelection', () => {
  it('collapses to none, to the single part, or to multi', () => {
    expect(combineSelection([])).toEqual(NO_SELECTION);
    expect(combineSelection([NO_SELECTION, NO_SELECTION])).toEqual(NO_SELECTION);
    expect(combineSelection([{ kind: 'wall', id: 'w' }])).toEqual({ kind: 'wall', id: 'w' });
    expect(
      combineSelection([{ kind: 'wall', id: 'w' }, fixtureSelection.make({ ids: ['l'] })]).kind
    ).toBe('multi');
  });

  it('flattens nested multis and keeps the first part per panel key', () => {
    const nested = combineSelection([
      { kind: 'vertex', indices: [1] },
      combineSelection([{ kind: 'vertex', indices: [9] }, fixtureSelection.make({ ids: ['l'] })]),
    ]);
    // Flat: two atoms, not a part that is itself a multi. `SelectionPart` excludes `multi`,
    // so the nesting is impossible at the type level too.
    expect(selectionParts(nested).map((p) => p.kind)).toEqual(['vertex', 'module']);
    expect(getSelectedVertexIndices(nested)).toEqual([1]);
    expect(getSelectedFixtureIds(nested)).toEqual(['l']);
  });

  it('asks for one panel per part', () => {
    const selection = combineSelection([
      { kind: 'vertex', indices: [0] },
      fixtureSelection.make({ ids: ['l'] }),
    ]);
    expect(selectionPanelKeys(selection)).toEqual(['core.vertex', 'lighting.fixture']);
  });
});

describe('toggleMember', () => {
  it('replaces without the modifier and toggles with it', () => {
    expect(toggleMember([1, 2], 3, false)).toEqual([3]);
    expect(toggleMember([1, 2], 3, true)).toEqual([1, 2, 3]);
    expect(toggleMember([1, 2], 2, true)).toEqual([1]);
  });
});
