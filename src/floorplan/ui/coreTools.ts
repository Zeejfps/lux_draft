import type { ModuleView, ToolDescriptor } from '../types/moduleRuntime';
import { CORE_TOOL_DOOR, CORE_TOOL_DRAW, CORE_TOOL_OBSTACLE } from '../types/state';

/**
 * Core's toolbar tools, as `ToolDescriptor`s.
 *
 * The toolbar is one loop over core's tools followed by the active module's, so a module's
 * button needs nothing in `Toolbar.svelte`. `select` is deliberately absent: it is the resting
 * tool, reachable with `V` or Escape, and has never had a button.
 *
 * Icons are inline SVG markup because that is what the toolbar already used, and a descriptor
 * that could not carry its own icon would put every module's button back in core.
 */

const requiresClosedRoom = (view: ModuleView<unknown>): boolean => view.geometry.boundary.isClosed;

export const CORE_TOOLBAR_TOOLS: readonly ToolDescriptor[] = [
  {
    id: CORE_TOOL_DRAW,
    label: 'Draw',
    title: 'Draw Walls (D)',
    key: 'd',
    icon: `<path d="M12 19l7-7 3 3-7 7-3-3z" />
      <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
      <path d="M2 2l7.586 7.586" />
      <circle cx="11" cy="11" r="2" />`,
  },
  {
    id: CORE_TOOL_DOOR,
    label: 'Door',
    title: 'Place Door',
    disabledTitle: 'Close room first',
    icon: `<path d="M3 21V3h18v18H3z" />
      <path d="M9 21V7l6-1v15" />
      <circle cx="13" cy="12" r="1" />`,
    enabled: requiresClosedRoom,
  },
  {
    id: CORE_TOOL_OBSTACLE,
    label: 'Obstacle',
    title: 'Draw Obstacle (O)',
    disabledTitle: 'Close room first',
    key: 'o',
    icon: `<rect x="6" y="6" width="12" height="12" rx="1" />
      <line x1="6" y1="12" x2="18" y2="12" />
      <line x1="12" y1="6" x2="12" y2="18" />`,
    enabled: requiresClosedRoom,
  },
];
