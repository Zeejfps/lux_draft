import type { Vector2 } from '../../floorplan/types/geometry';
import type { CommandKind, RegisteredCommand } from '../../floorplan/types/module';
import { defineCommand } from '../../floorplan/types/module';
import type { LayoutConfig, PlankSpec, Transition } from './types';
import type { FlooringData } from './codec';
import { flooringCodec, normalizeAngle } from './codec';

/**
 * Flooring's edits, as registered commands over `FlooringData`. **Eager** alongside the codec:
 * a module's edits must be dispatchable before its runtime loads.
 *
 * There is no `planks.*` command and there never will be — a plank is not editable data, it is
 * output. Everything here edits the four inputs the layout is a function of, which is what
 * makes undo step through user intent ("Change stagger") rather than through machine output.
 *
 * The move-and-set family carries absolute payloads (`absolute: true`): those are the commands
 * re-applied to the committed base on every frame of a drag, so applying twice must equal
 * applying once.
 */

/**
 * Set the whole layout config. One command rather than one per field, because the panel edits
 * a form and the undo entry the user wants is "Change floor layout", not eight of them.
 */
export const configureLayout: CommandKind<{ config: LayoutConfig }> = defineCommand(
  flooringCodec,
  'layout.configure',
  {
    label: () => 'Change floor layout',
    apply: (_doc, payload, prev) => ({
      ...prev,
      layout: {
        ...payload.config,
        runAngleDeg: normalizeAngle(payload.config.runAngleDeg),
        rowOffsetPattern: [...payload.config.rowOffsetPattern],
      },
    }),
  },
  { absolute: true }
);

/** The board being installed. Changing it re-derives the whole floor and the cut list. */
export const setPlankSpec: CommandKind<{ plank: PlankSpec }> = defineCommand(
  flooringCodec,
  'plank.set',
  {
    label: () => 'Change plank size',
    apply: (_doc, payload, prev) => ({ ...prev, plank: { ...payload.plank } }),
  },
  { absolute: true }
);

/**
 * Move the layout origin — the corner the installer starts from, and the point every row and
 * every plank joint is measured against.
 *
 * Absolute, because this is what `EntityDescriptor.moveCommand` returns: dragging the origin
 * marker previews this command against the committed base every frame (invariant 3).
 */
export const moveOrigin: CommandKind<{ position: Vector2 }> = defineCommand(
  flooringCodec,
  'origin.move',
  {
    label: () => 'Move layout origin',
    apply: (_doc, payload, prev) => ({ ...prev, origin: { ...payload.position } }),
  },
  { absolute: true }
);

/**
 * Trim a doorway. The payload names a `Door`, which already carries the wall, the offset and
 * the width — a transition adds the decision and the trim kind and nothing else.
 */
export const addTransition: CommandKind<{ transition: Transition }> = defineCommand(
  flooringCodec,
  'transition.add',
  {
    label: () => 'Add transition',
    apply: (_doc, payload, prev) => {
      // One transition per door: re-trimming a doorway replaces rather than stacks.
      const kept = prev.transitions.filter(
        (t) => t.id !== payload.transition.id && t.doorId !== payload.transition.doorId
      );
      return { ...prev, transitions: [...kept, { ...payload.transition }] };
    },
  }
);

export const removeTransition: CommandKind<{ transitionId: string }> = defineCommand(
  flooringCodec,
  'transition.remove',
  {
    label: () => 'Remove transition',
    apply: (_doc, payload, prev) => {
      const transitions = prev.transitions.filter((t) => t.id !== payload.transitionId);
      return transitions.length === prev.transitions.length
        ? (prev as FlooringData)
        : { ...prev, transitions };
    },
  }
);

export const flooringCommands: readonly RegisteredCommand[] = [
  configureLayout,
  setPlankSpec,
  moveOrigin,
  addTransition,
  removeTransition,
];
