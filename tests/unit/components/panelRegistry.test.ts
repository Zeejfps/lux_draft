/**
 * Panel dispatch resolves through `panelKey` for core *and* module selections, using the
 * same key the selection kind was registered under.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearPanels,
  panelsForSelection,
  registerPanel,
  registerPanels,
  resolvePanel,
  type PanelComponent,
} from '../../../src/floorplan/ui/panelRegistry';
import {
  combineSelection,
  NO_SELECTION,
  type Selection,
} from '../../../src/floorplan/types/selection';
import { fixtureSelection } from '../../../src/modules/lighting/selection';

// The registry only stores and hands back components; nothing here renders one.
const panel = (name: string) => ({ name }) as unknown as PanelComponent;

const WallPanel = panel('wall');
const VertexPanel = panel('vertex');
const ObstaclePanel = panel('obstacle');
const FixturePanel = panel('fixture');

describe('panel registry', () => {
  beforeEach(() => {
    clearPanels();
    registerPanels({
      'core.wall': WallPanel,
      'core.vertex': VertexPanel,
      'core.obstacle': ObstaclePanel,
      'core.obstacleVertex': ObstaclePanel,
      [fixtureSelection.panelKey]: FixturePanel,
    });
  });

  it('resolves a core selection by panel key', () => {
    expect(panelsForSelection({ kind: 'wall', id: 'w1' })).toEqual([
      { key: 'core.wall', component: WallPanel },
    ]);
  });

  it('resolves a module selection through the key defineSelection generated', () => {
    const selection = fixtureSelection.make({ ids: ['light-1'] });
    expect(panelsForSelection(selection)).toEqual([
      { key: 'lighting.fixture', component: FixturePanel },
    ]);
  });

  it('resolves every part of a heterogeneous selection', () => {
    const selection = combineSelection([
      { kind: 'vertex', indices: [0] },
      fixtureSelection.make({ ids: ['light-1'] }),
    ]);
    expect(panelsForSelection(selection).map((p) => p.key)).toEqual([
      'core.vertex',
      'lighting.fixture',
    ]);
  });

  it('two keys may share one component', () => {
    const selection: Selection = { kind: 'obstacleVertex', obstacleId: 'o1', indices: [1] };
    expect(panelsForSelection(selection)).toEqual([
      { key: 'core.obstacleVertex', component: ObstaclePanel },
    ]);
  });

  it('an empty selection dispatches to no panel', () => {
    expect(panelsForSelection(NO_SELECTION)).toEqual([]);
  });

  it('an unregistered kind dispatches to no panel rather than throwing', () => {
    expect(panelsForSelection({ kind: 'door', id: 'd1' })).toEqual([]);
    expect(resolvePanel('core.door')).toBeNull();
  });

  it('a duplicate panel key throws instead of shadowing', () => {
    expect(() => registerPanel('core.wall', VertexPanel)).toThrow(/Duplicate panel key/);
    expect(resolvePanel('core.wall')).toBe(WallPanel);
  });
});
