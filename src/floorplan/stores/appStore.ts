import { writable, derived, type Readable } from 'svelte/store';
import type { AppMode, ViewMode, Tool } from '../types';
import { CORE_TOOL_SELECT, isCoreTool } from '../types/state';
import { clearSelection } from './selectionStore';

export const appMode = writable<AppMode>('drafting');
export const viewMode = writable<ViewMode>('editor');
export const activeTool = writable<Tool>(CORE_TOOL_SELECT);

// Signal to request camera fit (only used when loading/importing projects)
export const shouldFitCamera = writable<boolean>(false);

export function requestCameraFit(): void {
  shouldFitCamera.set(true);
}

export const isDrawingEnabled = derived(
  [appMode, activeTool],
  ([$mode, $tool]) => $mode === 'drafting' && $tool === 'draw'
);

/**
 * A tool contributed by the active module owns the pointer, so core's click-through handlers
 * (selection, box select) stand down. Core knows *that* a module tool is active, never which.
 */
export const isModuleToolActive = derived(
  [appMode, activeTool],
  ([$mode, $tool]) => $mode === 'drafting' && !isCoreTool($tool)
);

/** Is this specific tool the active one? What a module's own handler asks. */
export function isToolActive(toolId: Tool): Readable<boolean> {
  return derived(
    [appMode, activeTool],
    ([$mode, $tool]) => $mode === 'drafting' && $tool === toolId
  );
}

export const isDoorPlacementEnabled = derived(
  [appMode, activeTool],
  ([$mode, $tool]) => $mode === 'drafting' && $tool === 'door'
);

export const isObstacleDrawingEnabled = derived(
  [appMode, activeTool],
  ([$mode, $tool]) => $mode === 'drafting' && $tool === 'obstacle'
);

export function setViewMode(mode: ViewMode): void {
  viewMode.set(mode);
  if (mode !== 'editor') {
    appMode.set('viewing');
  } else {
    appMode.set('drafting');
  }
}

export function setActiveTool(tool: Tool): void {
  activeTool.set(tool);
  clearSelection();
}
