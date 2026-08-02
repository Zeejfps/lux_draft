import { FLOORING_MODULE_ID } from './codec';

/**
 * Eager-safe constants shared by the codec half and the runtime half.
 *
 * Tool and overlay ids are `${moduleId}.${verb}` — `validateRuntime` claims them at first
 * resolution and throws on a duplicate or a badly namespaced one.
 */

/** The transition tool: click a doorway to trim it. */
export const FLOORING_TOOL_TRANSITION = `${FLOORING_MODULE_ID}.transition`;

/** The divider tool: click two points to draw the line where the floor changes. */
export const FLOORING_TOOL_DIVIDER = `${FLOORING_MODULE_ID}.divider`;

/** Click tolerance for the layout origin marker, in feet. */
export const ORIGIN_HIT_TOLERANCE_FT = 0.6;

/** Click tolerance for a doorway when the transition tool is active, in feet. */
export const DOOR_HIT_TOLERANCE_FT = 1.5;

/** The single layout-origin entity's id. There is exactly one per document. */
export const LAYOUT_ORIGIN_ID = 'layout-origin';
