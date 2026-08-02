import { defineSelection, NO_SELECTION, type Selection } from '../../floorplan/types/selection';

/**
 * Lighting fixture selection.
 *
 * Lighting is a module, so there is no `light` variant on the core `Selection` union. This is
 * the plan's extension point used early (phase 2 lands before lighting's data moves into a
 * module slice in 3b): `defineSelection` needs no module system, just the two functions, and
 * nothing has to be unwound later — phase 4 moves this file under `src/modules/lighting/` and
 * the `panelKey` string `lighting.fixture` stays the same.
 */
export interface FixtureSelectionPayload {
  ids: string[];
}

export const fixtureSelection = defineSelection<FixtureSelectionPayload>(
  'lighting',
  'fixture',
  (payload) => {
    if (typeof payload !== 'object' || payload === null) return null;
    const ids = (payload as { ids?: unknown }).ids;
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) return null;
    return { ids: ids as string[] };
  }
);

/** Selected fixture ids, or an empty array. Reads through a `multi` selection. */
export function getSelectedFixtureIds(selection: Selection): readonly string[] {
  return fixtureSelection.match(selection)?.ids ?? [];
}

/** A fixture selection, or `none` when the id list is empty. */
export function fixtureSelectionOf(ids: readonly string[]): Selection {
  return ids.length > 0 ? fixtureSelection.make({ ids: [...ids] }) : NO_SELECTION;
}
