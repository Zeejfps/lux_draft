import type { IInteractionHandler } from '../../floorplan/types/interaction';
import type {
  ActivationScope,
  ModuleContext,
  ModuleRuntime,
  ModuleView,
  OverlayToggle,
  PanelComponent,
  SceneLayer,
} from '../../floorplan/types/moduleRuntime';
import type { EntityDescriptor } from '../../floorplan/types/entity';
import type { Door, WallSegment } from '../../floorplan/types/geometry';
import { FLOORING_MODULE_ID, type FlooringData } from './codec';
import { FLOORING_TOOL_DIVIDER, FLOORING_TOOL_TRANSITION } from './constants';
import { originEntities } from './entities';
import { createFlooringLayers } from './layers';
import {
  DividerPlacementHandler,
  PlankHoverHandler,
  PlankPickHandler,
  TransitionPlacementHandler,
} from './handlers';
import { selection } from '../../floorplan/stores/selectionStore';
import { isEmptySelection } from '../../floorplan/types/selection';
import {
  addDoorTransition,
  addFloorDivider,
  currentPlankIndex,
  hoveredPlank,
  layoutPanelVisible,
  pendingDivider,
  planksVisible,
  removeDoorTransition,
  selectPlank,
  selectedPlank,
  startLayoutService,
  summaryVisible,
  toggleLayoutPanel,
  togglePlanks,
  toggleSummary,
} from './store';
import CutListPanel from './ui/CutListPanel.svelte';
import FloorLayoutPanel from './ui/FloorLayoutPanel.svelte';
import PlankInfoPanel from './ui/PlankInfoPanel.svelte';

/**
 * The flooring module's **lazy** half (invariant 7).
 *
 * `codec.ts` and `commands.ts` may not import this file, and the lint enforces it: THREE, the
 * plank renderer, the layout engine and every flooring panel stay out of the eager chunk that
 * `decodeDocument` needs.
 *
 * This file is the honest measure of how additive a second module is. It declares tools,
 * overlays, one entity, three layers, four handlers and three surfaces, and **nothing
 * else** — no routing, no toolbar wiring, no selection plumbing, no hit-testing, no keyboard
 * handling, no share support, no persistence. All of that already worked.
 */

const PLANK_ICON = `<rect x="2" y="4" width="9" height="5" rx="1" />
  <rect x="13" y="4" width="9" height="5" rx="1" />
  <rect x="2" y="10" width="14" height="5" rx="1" />
  <rect x="2" y="16" width="9" height="5" rx="1" />`;

const TRANSITION_ICON = `<path d="M3 12h18" />
  <path d="M8 8v8" />
  <path d="M16 8v8" />
  <path d="M3 6v12" />
  <path d="M21 6v12" />`;

const DIVIDER_ICON = `<path d="M4 4v16" />
  <path d="M20 4v16" />
  <path d="M4 12h16" />
  <path d="M7 7h2" />
  <path d="M15 17h2" />`;

const LAYOUT_ICON = `<rect x="3" y="3" width="18" height="18" rx="2" />
  <path d="M3 9h18" />
  <path d="M3 15h18" />
  <path d="M12 3v6" />
  <path d="M8 15v6" />`;

const SUMMARY_ICON = `<path d="M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-4" />
  <path d="M9 3v4h6V3" />
  <path d="M8 12h8" />
  <path d="M8 16h5" />`;

const OVERLAYS: readonly OverlayToggle[] = [
  {
    id: `${FLOORING_MODULE_ID}.planks`,
    label: 'Floor',
    title: 'Show the derived plank layout',
    icon: PLANK_ICON,
    active: planksVisible,
    toggle: togglePlanks,
  },
  {
    id: `${FLOORING_MODULE_ID}.layout`,
    label: 'Layout',
    title: 'Floor layout settings (F)',
    icon: LAYOUT_ICON,
    active: layoutPanelVisible,
    toggle: toggleLayoutPanel,
  },
  {
    id: `${FLOORING_MODULE_ID}.summary`,
    label: 'Cut List',
    title: 'Cut list and waste (C)',
    icon: SUMMARY_ICON,
    active: summaryVisible,
    toggle: toggleSummary,
  },
];

export const flooringRuntime: ModuleRuntime = {
  id: FLOORING_MODULE_ID,
  label: 'Flooring',

  tools: [
    {
      id: FLOORING_TOOL_TRANSITION,
      label: 'Transition',
      title: 'Trim a doorway (T)',
      disabledTitle: 'Add a door first',
      key: 't',
      icon: TRANSITION_ICON,
      // A doorway to trim is core's `Door`, so the tool's own enablement reads core geometry.
      enabled: (view: ModuleView<unknown>) => view.geometry.doors.length > 0,
    },
    {
      id: FLOORING_TOOL_DIVIDER,
      label: 'Divider',
      title: 'Draw where this floor ends and another begins (D)',
      disabledTitle: 'Close the room first',
      key: 'd',
      icon: DIVIDER_ICON,
      // A divider is a chord of the room, so there has to be a room to cut.
      enabled: (view: ModuleView<unknown>) => view.geometry.boundary.isClosed,
    },
  ],

  overlays: OVERLAYS,

  entities: originEntities as EntityDescriptor<unknown>,

  // No selection-driven panels: the origin is edited in the Floor Layout surface, which
  // highlights its Origin section when the marker is selected.

  surfaces: [FloorLayoutPanel, CutListPanel, PlankInfoPanel] as unknown as PanelComponent[],

  shortcuts: [
    { key: 'f', description: 'Toggle floor layout settings', run: () => toggleLayoutPanel() },
    { key: 'c', description: 'Toggle the cut list', run: () => toggleSummary() },
  ],

  layers(scene): SceneLayer[] {
    return createFlooringLayers(scene).layers;
  },

  handlers(ctx: ModuleContext<unknown>): IInteractionHandler[] {
    const view = () => ctx.view() as ModuleView<FlooringData>;
    return [
      new TransitionPlacementHandler({
        getDoors: () => view().geometry.doors as Door[],
        getWalls: () => view().geometry.boundary.walls as WallSegment[],
        getTransitions: () => view().data.transitions,
        addTransition: (doorId) => addDoorTransition(doorId),
        removeTransition: (id) => removeDoorTransition(id),
      }),
      new DividerPlacementHandler({
        getWalls: () => view().geometry.boundary.walls as WallSegment[],
        getDividers: () => view().data.dividers,
        setPending: (pending) => pendingDivider.set(pending),
        addDivider: (a, b) => addFloorDivider(a, b),
      }),
      new PlankHoverHandler({
        plankAt: (position) => currentPlankIndex()?.at(position) ?? null,
        setHovered: (plank) => hoveredPlank.set(plank),
      }),
      new PlankPickHandler({
        plankAt: (position) => currentPlankIndex()?.at(position) ?? null,
        setSelected: (plank) => selectPlank(plank),
      }),
    ];
  },

  onActivate(_ctx: ModuleContext<unknown>, scope: ActivationScope): void {
    // The projection cache and its pending work belong to the scope, exactly as the plan
    // requires: "scene layers, input handlers, shortcut bindings, derived subscriptions,
    // projection caches, workers and pending async work all register with it". Disposal aborts
    // `scope.signal` first, so a computation in flight when the user switches modes is dropped
    // rather than delivered into a disposed renderer.
    scope.own(startLayoutService(scope.signal));
    scope.own(() => hoveredPlank.set(null));
    // A board read-out and a core selection are two answers to the same click, so the later one
    // wins: `PlankPickHandler` runs first and core's selection handler runs after it, which means
    // a click that landed on a wall, a vertex, a door, an obstacle or the origin marker ends with
    // a selection and drops the board it also passed through. A click on bare floor selects
    // nothing, so the board stands. Cheaper and more honest than re-running core's hit tests
    // inside the flooring handler, which would have to agree with them forever.
    scope.own(
      selection.subscribe((current) => {
        if (!isEmptySelection(current)) selectPlank(null);
      })
    );
    scope.own(() => selectedPlank.set(null));
    // A half-drawn divider is a gesture, and a gesture does not survive a mode switch.
    scope.own(() => pendingDivider.set(null));
  },
};
