import { defineSelection, NO_SELECTION, type Selection } from '../../floorplan/types/selection';
import { FLOORING_MODULE_ID } from './codec';
import { LAYOUT_ORIGIN_ID } from './constants';

/**
 * Flooring's selection kinds.
 *
 * `origin` is the only one, and it is cardinality-shaped as `{ ids: string[] }` because that is
 * what `EntityDescriptor` requires — core's box select and grab mode work on id lists. There is
 * exactly one origin, so the list holds at most one member.
 *
 * **Planks are deliberately not a selection kind.** They are derived output, re-derived on
 * every geometry edit; a selection naming one would be a reference into a value that does not
 * survive the next wall drag. Plank *hit-testing* exists (`PlankIndex`) and drives a hover
 * read-out, which is the part that is genuinely useful without pretending planks are entities.
 */
export interface OriginSelectionPayload {
  ids: string[];
}

export const originSelection = defineSelection<OriginSelectionPayload>(
  FLOORING_MODULE_ID,
  'origin',
  (payload) => {
    if (typeof payload !== 'object' || payload === null) return null;
    const ids = (payload as { ids?: unknown }).ids;
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) return null;
    return { ids: ids as string[] };
  }
);

/** True when the layout origin is part of this selection, including inside a `multi`. */
export function isOriginSelected(selection: Selection): boolean {
  return (originSelection.match(selection)?.ids ?? []).includes(LAYOUT_ORIGIN_ID);
}

export function originSelectionOf(ids: readonly string[]): Selection {
  return ids.length > 0 ? originSelection.make({ ids: [...ids] }) : NO_SELECTION;
}
