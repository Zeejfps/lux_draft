import type { Vector2 } from '../../floorplan/types';
import type { EntityDescriptor } from '../../floorplan/types/entity';
import type { LightingData } from './codec';
import { moveFixture, removeFixture } from './commands';
import { LIGHT_HIT_TOLERANCE_FT } from './constants';
import { fixtureSelection } from './selection';

/**
 * Fixtures as core-visible point entities.
 *
 * This is the whole of what `src/floorplan/` may know about a light: an id, a position, the
 * selection kind that names it, and two commands. It lives beside the codec rather than in
 * `runtime.ts` because it pulls in neither THREE nor a Svelte component, and the drag tests
 * want it without loading the rendering half.
 */
export const fixtureEntities: EntityDescriptor<LightingData> = {
  selection: fixtureSelection,
  label: 'Lights',
  hitTolerance: LIGHT_HIT_TOLERANCE_FT,
  list: (view) => view.data.fixtures,
  // Absolute, so a drag re-applies it to the committed base every frame (invariant 3).
  moveCommand: (id: string, position: Vector2) => moveFixture.make({ fixtureId: id, position }),
  removeCommand: (ids: readonly string[]) => {
    const commands = ids.map((fixtureId) => removeFixture.make({ fixtureId }));
    if (commands.length === 0) return null;
    return commands.length === 1
      ? commands[0]
      : { type: 'compound', label: 'Delete lights', commands };
  },
};
