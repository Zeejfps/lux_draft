import type { Vector2 } from './geometry';
import type { EditorCommand } from './command';
import type { Selection, SelectionKind } from './selection';
import type { ModuleView } from './moduleRuntime';
import { NO_SELECTION } from './selection';

/**
 * Point-like module entities, and the seam through which core interaction code touches them.
 *
 * Core hit-testing, box selection, grab mode, snapping and the unified drag all need to see
 * *something* the active module owns — before phase 4 that was `InteractionContext.fixtures`
 * plus a core import of `lighting/selection` and `lighting/commands`. Neither survives the
 * `floorplan/` boundary, and neither generalizes: flooring will contribute transitions and a
 * layout origin, not fixtures.
 *
 * A module declares an `EntityDescriptor` on its runtime; the registry binds it to the live
 * `ModuleView` and hands core an `EntityAccess`, which names no module and carries no domain
 * type. Everything core needs is here: identity, position, selection, and an absolute move
 * command.
 */

/** A selectable, movable point a module contributes. The whole of what core may know. */
export interface ModuleEntity {
  readonly id: string;
  readonly position: Vector2;
}

/** What a module declares. Bound to a live view by the registry, never called by core. */
export interface EntityDescriptor<T> {
  /** The selection kind these entities use. Supplies the module id, type and panel key. */
  readonly selection: SelectionKind<{ ids: string[] }>;
  /** Plural noun for the shell's read-outs, e.g. `Lights`. Core never spells one out. */
  readonly label: string;
  /** Click tolerance in feet. */
  readonly hitTolerance: number;
  /** The entities present in this view. */
  list(view: ModuleView<T>): readonly ModuleEntity[];
  /**
   * An absolute move command for one entity — a member of the move-and-set family, so a drag
   * can re-apply it to the committed base every frame (invariant 3).
   */
  moveCommand(id: string, position: Vector2): EditorCommand;
  /**
   * Delete these entities. One command, so one history entry — core's Delete key works on a
   * module's entities without core knowing what they are. Null when there is nothing to do.
   */
  removeCommand(ids: readonly string[]): EditorCommand | null;
}

/** The bound, live form core interaction code holds. */
export interface EntityAccess {
  readonly moduleId: string;
  readonly type: string;
  readonly label: string;
  readonly hitTolerance: number;
  list(): readonly ModuleEntity[];
  find(id: string): ModuleEntity | null;
  at(position: Vector2, tolerance?: number): ModuleEntity | null;
  inBox(a: Vector2, b: Vector2): string[];
  selectedIds(selection: Selection): readonly string[];
  selectionOf(ids: readonly string[]): Selection;
  moveCommand(id: string, position: Vector2): EditorCommand;
  removeCommand(ids: readonly string[]): EditorCommand | null;
}

function distanceSquared(a: Vector2, b: Vector2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/**
 * No module is active (or the active one contributes no entities). Total, so core code never
 * branches on "is there a module".
 */
export const NO_ENTITIES: EntityAccess = {
  moduleId: '',
  type: '',
  label: '',
  hitTolerance: 0,
  list: () => [],
  find: () => null,
  at: () => null,
  inBox: () => [],
  selectedIds: () => [],
  selectionOf: () => NO_SELECTION,
  moveCommand: () => {
    throw new Error('No module entities are active; there is nothing to move.');
  },
  removeCommand: () => null,
};

/** Bind a descriptor to a live view. The registry's job; the result is what core sees. */
export function bindEntities<T>(
  descriptor: EntityDescriptor<T>,
  view: () => ModuleView<T>
): EntityAccess {
  const list = (): readonly ModuleEntity[] => descriptor.list(view());
  return {
    moduleId: descriptor.selection.moduleId,
    type: descriptor.selection.type,
    label: descriptor.label,
    hitTolerance: descriptor.hitTolerance,
    list,
    find: (id) => list().find((entity) => entity.id === id) ?? null,
    at: (position, tolerance = descriptor.hitTolerance) => {
      const limit = tolerance * tolerance;
      for (const entity of list()) {
        if (distanceSquared(position, entity.position) <= limit) return entity;
      }
      return null;
    },
    inBox: (a, b) => {
      const minX = Math.min(a.x, b.x);
      const maxX = Math.max(a.x, b.x);
      const minY = Math.min(a.y, b.y);
      const maxY = Math.max(a.y, b.y);
      return list()
        .filter(
          ({ position }) =>
            position.x >= minX && position.x <= maxX && position.y >= minY && position.y <= maxY
        )
        .map((entity) => entity.id);
    },
    selectedIds: (selection) => descriptor.selection.match(selection)?.ids ?? [],
    selectionOf: (ids) =>
      ids.length > 0 ? descriptor.selection.make({ ids: [...ids] }) : NO_SELECTION,
    moveCommand: (id, position) => descriptor.moveCommand(id, position),
    removeCommand: (ids) => descriptor.removeCommand(ids),
  };
}
