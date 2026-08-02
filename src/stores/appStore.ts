import { writable, derived } from 'svelte/store';
import type { AppMode, ViewMode, Tool } from '../types';
import { clearSelection } from './selectionStore';

export const appMode = writable<AppMode>('drafting');
export const viewMode = writable<ViewMode>('editor');
export const activeTool = writable<Tool>('select');

// Signal to request camera fit (only used when loading/importing projects)
export const shouldFitCamera = writable<boolean>(false);

export function requestCameraFit(): void {
  shouldFitCamera.set(true);
}

export const isDrawingEnabled = derived(
  [appMode, activeTool],
  ([$mode, $tool]) => $mode === 'drafting' && $tool === 'draw'
);

export const isLightPlacementEnabled = derived(
  [appMode, activeTool],
  ([$mode, $tool]) => $mode === 'drafting' && $tool === 'light'
);

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
