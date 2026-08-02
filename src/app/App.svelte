<script context="module" lang="ts">
  import VertexPropertiesPanel from '../floorplan/ui/VertexPropertiesPanel.svelte';
  import WallPropertiesPanel from '../floorplan/ui/WallPropertiesPanel.svelte';
  import DoorPropertiesPanel from '../floorplan/ui/DoorPropertiesPanel.svelte';
  import ObstaclePropertiesPanel from '../floorplan/ui/ObstaclePropertiesPanel.svelte';
  import { registerPanels } from '../floorplan/ui/panelRegistry';
  import { claimCorePanelKeys } from '../floorplan/types/moduleRegistry';

  /**
   * **Core** panel registration. Keys are `SelectionKind.panelKey`, so registration and
   * dispatch cannot disagree; dispatch happens below through `panelsForSelection`.
   *
   * A module's panels are not here: the activation registry registers `ModuleRuntime.panels`
   * when the runtime loads and unregisters them when the scope is disposed. Core claims its
   * keys with the registry so a module cannot shadow one.
   */
  const CORE_PANELS = {
    'core.vertex': VertexPropertiesPanel,
    'core.wall': WallPropertiesPanel,
    'core.door': DoorPropertiesPanel,
    'core.obstacle': ObstaclePropertiesPanel,
    // An obstacle-vertex selection edits the obstacle it belongs to.
    'core.obstacleVertex': ObstaclePropertiesPanel,
  };

  claimCorePanelKeys(Object.keys(CORE_PANELS));
  registerPanels(CORE_PANELS);
</script>

<script lang="ts">
  import { onMount, onDestroy, type ComponentType } from 'svelte';
  import Canvas from '../floorplan/ui/Canvas.svelte';
  import Toolbar from './Toolbar.svelte';
  import PropertyPanel from './PropertyPanel.svelte';
  import DoorToolPanel from '../floorplan/ui/DoorToolPanel.svelte';
  import StatusBar from './StatusBar.svelte';
  import LengthInput from '../floorplan/ui/LengthInput.svelte';
  import ModePicker from './ModePicker.svelte';
  import DiagnosticsBanner from './DiagnosticsBanner.svelte';
  import { openLoaded } from '../floorplan/stores/roomStore';
  import { saveInput } from '../floorplan/stores/sessionStore';
  import { activeTool, setActiveTool, requestCameraFit } from '../floorplan/stores/appStore';
  import { moduleSurfaces, toolbarTools } from '../floorplan/stores/moduleActivation';
  import { CORE_TOOL_DRAW, CORE_TOOL_SELECT } from '../floorplan/types/state';
  import { selection } from '../floorplan/stores/selectionStore';
  import { panelsForSelection } from '../floorplan/ui/panelRegistry';
  import { loadFromLocalStorage, setupAutoSave } from '../floorplan/persistence/localStorage';
  import { toggleGridSnap } from '../floorplan/stores/settingsStore';
  import { togglePropertiesPanel } from '../floorplan/stores/propertiesPanelStore';
  import { currentRoute } from './routerStore';
  import { startModuleRouting } from './moduleRouting';
  import '../floorplan/stores/themeStore'; // Initialize theme CSS variables
  import type { Vector2 } from '../floorplan/types';

  let canvasComponent: Canvas;
  let mousePos: Vector2 = { x: 0, y: 0 };
  let snapType: string = '';

  // Reactive route binding
  $: route = $currentRoute;

  /**
   * The viewer is a whole second page and it is lighting-shaped end to end; importing it
   * statically would put the heatmap shaders and every light panel in the editor's chunk. It
   * arrives through the same `import()` mechanism a module runtime does.
   */
  let ViewerPage: ComponentType | null = null;
  let viewerRequested = false;

  function loadViewerPage(): void {
    if (viewerRequested) return;
    viewerRequested = true;
    void import('./viewer/ViewerPage.svelte').then((m) => {
      ViewerPage = m.default as unknown as ComponentType;
    });
  }

  $: if (route.kind === 'viewer') loadViewerPage();

  let showLengthInput: boolean = false;
  let cleanupAutoSave: (() => void) | null = null;
  let stopModuleRouting: (() => void) | null = null;
  let measurement: { deltaX: number; deltaY: number; distance: number } | null = null;

  function handleMouseMove(e: CustomEvent<{ worldPos: Vector2 }>): void {
    mousePos = e.detail.worldPos;
  }

  function handleSnapChange(e: CustomEvent<{ snapType: string }>): void {
    snapType = e.detail.snapType;
  }

  function handleMeasurement(
    e: CustomEvent<{ deltaX: number; deltaY: number; distance: number } | null>
  ): void {
    measurement = e.detail;
  }

  function handleToggleMeasurement(): void {
    // Simulate pressing 'M' key to toggle measurement
    const event = new KeyboardEvent('keydown', { key: 'm' });
    window.dispatchEvent(event);
  }

  function handleLengthSubmit(e: CustomEvent<{ length: number }>): void {
    canvasComponent?.setManualLength(e.detail.length);
    showLengthInput = false;
  }

  function handleLengthCancel(): void {
    showLengthInput = false;
  }

  function handleGlobalKeydown(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) {
      return;
    }

    const key = e.key.toLowerCase();

    switch (key) {
      case 'escape':
        // Back to the resting tool from any placement or drawing tool, core's or a module's.
        if ($activeTool !== CORE_TOOL_SELECT) {
          setActiveTool(CORE_TOOL_SELECT);
        }
        return;
      case 'v':
        setActiveTool(CORE_TOOL_SELECT);
        return;
      case 's':
        toggleGridSnap();
        return;
      case 'p':
        togglePropertiesPanel();
        return;
    }

    // `L` while drawing means "type a wall length", not "pick the light tool". That one
    // overload is core's, and it wins; every other tool key resolves through the registry.
    if (key === 'l' && $activeTool === CORE_TOOL_DRAW) {
      showLengthInput = true;
      return;
    }

    // Tool selection keys come from the tool descriptors — core's first, so a module tool can
    // never take a key core already uses for one of its own.
    const tool = $toolbarTools.find((t) => t.descriptor.key === key && t.enabled);
    if (tool) {
      setActiveTool(tool.descriptor.id);
    }
  }

  onMount(() => {
    // The viewer owns its own document (a share link or an opened file) and has no session to
    // restore; everything below is the editor's.
    if (route.kind === 'viewer') return;

    // Every load path ends in one `open` with a real decode result (invariant 9). The
    // definition-adoption step that used to live here is now the lighting module's own, run
    // from `onActivate` — the shell no longer names it.
    const loaded = loadFromLocalStorage();
    if (loaded) {
      openLoaded(loaded);
      // Fit camera to the loaded project
      requestCameraFit();
    }

    cleanupAutoSave = setupAutoSave(saveInput);
    window.addEventListener('keydown', handleGlobalKeydown);

    // Activation follows the route from here on: exactly one module is active, and which one
    // is the URL's business rather than this component's.
    stopModuleRouting = startModuleRouting();
  });

  onDestroy(() => {
    if (cleanupAutoSave) {
      cleanupAutoSave();
    }
    if (stopModuleRouting) {
      stopModuleRouting();
    }
    window.removeEventListener('keydown', handleGlobalKeydown);
  });
</script>

{#if route.kind === 'viewer'}
  {#if ViewerPage}
    <svelte:component this={ViewerPage} moduleId={route.moduleId} />
  {/if}
{:else if route.kind === 'picker'}
  <ModePicker />
{:else}
  <div class="app">
    <Toolbar on:toggleMeasurement={handleToggleMeasurement} />

    <main class="main">
      <div class="canvas-area">
        <Canvas
          bind:this={canvasComponent}
          on:mouseMove={handleMouseMove}
          on:snapChange={handleSnapChange}
          on:measurement={handleMeasurement}
        />
        {#if measurement}
          <div class="measurement-panel">
            <div class="measurement-title">Measurement</div>
            <div class="measurement-row">
              <span class="measurement-label" style="color: var(--measurement-x);">ΔX:</span>
              <span class="measurement-value">{Math.abs(measurement.deltaX).toFixed(2)} ft</span>
            </div>
            <div class="measurement-row">
              <span class="measurement-label" style="color: var(--measurement-y);">ΔY:</span>
              <span class="measurement-value">{Math.abs(measurement.deltaY).toFixed(2)} ft</span>
            </div>
            <div class="measurement-row">
              <span class="measurement-label" style="color: var(--measurement-distance);"
                >Distance:</span
              >
              <span class="measurement-value">{measurement.distance.toFixed(2)} ft</span>
            </div>
            <div class="measurement-hint">Press M or Esc to clear</div>
          </div>
        {/if}
        <!--
          The active module's free-standing UI. The shell mounts the list and names none of
          it: tool panels, stats read-outs and modals all arrive through the manifest, which
          is what keeps them out of the eager chunk.
        -->
        {#each $moduleSurfaces as surface, index (index)}
          <svelte:component this={surface} />
        {/each}
        <DoorToolPanel />
        <PropertyPanel />
        <DiagnosticsBanner />
        {#each panelsForSelection($selection) as panel (panel.key)}
          <svelte:component this={panel.component} />
        {/each}
      </div>
    </main>

    <StatusBar {mousePos} {snapType} />

    <LengthInput
      visible={showLengthInput}
      on:submit={handleLengthSubmit}
      on:cancel={handleLengthCancel}
    />
  </div>
{/if}

<style>
  :global(*) {
    box-sizing: border-box;
  }

  :global(body) {
    margin: 0;
    padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    overflow: hidden;
    background: var(--input-bg);
    color: var(--text-secondary);
  }

  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: var(--input-bg);
  }

  .main {
    display: flex;
    flex: 1;
    overflow: hidden;
  }

  .canvas-area {
    flex: 1;
    position: relative;
    overflow: hidden;
  }

  .measurement-panel {
    position: absolute;
    top: var(--spacing-16);
    left: var(--spacing-16);
    background: var(--panel-bg);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-lg);
    padding: var(--spacing-12) var(--spacing-16);
    box-shadow: var(--shadow-md);
    font-size: 13px;
    min-width: 160px;
  }

  .measurement-title {
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: var(--spacing-8);
    padding-bottom: 6px;
    border-bottom: 1px solid var(--border-color);
  }

  .measurement-row {
    display: flex;
    justify-content: space-between;
    margin-bottom: var(--spacing-4);
  }

  .measurement-label {
    font-weight: 500;
    color: var(--text-secondary);
  }

  .measurement-value {
    font-family: monospace;
    color: var(--text-primary);
  }

  .measurement-hint {
    margin-top: 8px;
    font-size: 11px;
    color: var(--text-muted);
    text-align: center;
  }

  /* Shared property panel styles */
  :global(.panel-section) {
    margin-bottom: 24px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--border-color);
  }

  :global(.panel-section:last-child) {
    border-bottom: none;
    margin-bottom: 0;
  }

  :global(.panel-row) {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
    font-size: 13px;
  }

  :global(.panel-row > span:first-child),
  :global(.panel-row > label > span:first-child) {
    font-size: 12px;
    color: var(--text-muted);
  }

  :global(.panel-select) {
    padding: 8px;
    background: var(--input-bg);
    color: var(--text-secondary);
    border: 1px solid var(--input-border);
    border-radius: 4px;
    font-size: 13px;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  :global(.panel-select:focus) {
    outline: none;
    border-color: var(--button-active);
  }

  :global(.panel-input) {
    padding: 4px 6px;
    border: 1px solid var(--input-border);
    border-radius: 4px;
    font-size: 13px;
    background: var(--input-bg);
    color: var(--text-primary);
    text-align: right;
    font-family: monospace;
  }

  :global(.panel-input:focus) {
    outline: none;
    border-color: var(--button-active);
  }

  :global(.panel-info-box) {
    background: var(--input-bg);
    border: 1px solid var(--border-color);
    border-radius: 4px;
    padding: 8px 12px;
    margin: 8px 0;
  }

  :global(.panel-info-row) {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    padding: 2px 0;
  }

  :global(.panel-info-row > span:first-child) {
    color: var(--text-muted);
  }

  :global(.panel-info-row > span:last-child) {
    font-weight: 500;
    color: var(--text-primary);
  }

  :global(.panel-delete-btn) {
    width: 100%;
    padding: 8px;
    margin-top: 12px;
    background: var(--status-error);
    color: white;
    border: none;
    border-radius: 4px;
    font-size: 13px;
    cursor: pointer;
    transition: background 0.15s ease;
  }

  :global(.panel-delete-btn:hover) {
    background: #dc2626;
  }

  :global(.panel-hint) {
    margin: 12px 0 0 0;
    font-size: 11px;
    color: var(--text-muted);
    line-height: 1.4;
    font-style: italic;
    padding: 8px;
    background: rgba(251, 191, 36, 0.1);
    border: 1px solid rgba(251, 191, 36, 0.2);
    border-radius: 4px;
  }

  :global(.panel-hint.warning) {
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.2);
  }

  :global(.panel-coords) {
    font-family: monospace;
    font-size: 12px;
  }
</style>
