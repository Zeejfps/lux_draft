import type { Vector2 } from '../../floorplan/types';
import type { EntityDescriptor } from '../../floorplan/types/entity';
import type { FlooringData } from './codec';
import { moveOrigin } from './commands';
import { LAYOUT_ORIGIN_ID, ORIGIN_HIT_TOLERANCE_FT } from './constants';
import { originSelection } from './selection';

/**
 * The layout origin as a core-visible point entity.
 *
 * This is the second module through the phase-4 entity seam, and it is a deliberately different
 * shape from lighting's: **one** entity rather than a list, and one that cannot be deleted. The
 * seam takes both without a change — `removeCommand` returning `null` is already the contract
 * for "there is nothing to delete", so core's Delete key does nothing to the origin and says so
 * by doing nothing.
 *
 * What falls out for free: click-select, shift-box-select, grab mode, snapping to walls and
 * vertices, the measurement tool measuring *from* the origin, and the property panel's count
 * row. None of that is written here.
 */
export const originEntities: EntityDescriptor<FlooringData> = {
  selection: originSelection,
  label: 'Layout origin',
  hitTolerance: ORIGIN_HIT_TOLERANCE_FT,
  list: (view) => [{ id: LAYOUT_ORIGIN_ID, position: view.data.origin }],
  // Absolute, so a drag re-applies it to the committed base every frame (invariant 3).
  moveCommand: (_id: string, position: Vector2) => moveOrigin.make({ position }),
  // The origin is a property of the layout, not a thing you can remove.
  removeCommand: () => null,
};
