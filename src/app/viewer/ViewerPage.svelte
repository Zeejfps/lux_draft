<script lang="ts">
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import ViewerToolbar from './ViewerToolbar.svelte';
  import ViewerCanvas from './ViewerCanvas.svelte';
  import ViewerStatsPanel from './ViewerStatsPanel.svelte';
  import LightInfoBottomSheet from '../../modules/lighting/ui/LightInfoBottomSheet.svelte';
  import { openLoaded } from '../../floorplan/stores/roomStore';
  import { adoptIncomingDefinitions, committedLightingData } from '../../modules/lighting/store';
  import { LIGHTING_MODULE_ID } from '../../modules/lighting/codec';
  import { requestCameraFit } from '../../floorplan/stores/appStore';
  import { lightingStatsConfig } from '../../modules/lighting/statsStore';
  import { importFromJSON, ValidationError } from '../../floorplan/persistence/jsonImport';
  import { routeParams } from '../routerStore';
  import { decodeShareData } from '../../floorplan/persistence/shareUrl';
  import type { ViewMode } from '../../floorplan/types';

  /**
   * The module this viewer is showing, from the route (`#/{moduleId}/viewer`).
   *
   * The viewer is still lighting-shaped end to end — it builds lighting's layers by hand
   * because it has no editor session and therefore no activation registry. Carrying the id
   * makes the share button module-correct and is what a second viewing mode would branch on.
   */
  export let moduleId: string = LIGHTING_MODULE_ID;

  let viewMode: ViewMode = 'editor';
  let hasProject = false;
  let errorMessage = '';
  let toolbar: ViewerToolbar;

  onMount(() => {
    const params = get(routeParams);
    if (params.d) {
      try {
        const loaded = decodeShareData(params.d);
        openLoaded(loaded);
        // No activation registry here, so the viewer runs the module's adoption step itself.
        adoptIncomingDefinitions($committedLightingData.definitions);
        hasProject = true;

        if ($committedLightingData.fixtures.length > 0) {
          lightingStatsConfig.update((c) => ({ ...c, visible: true }));
        }

        requestCameraFit();
      } catch (err) {
        if (err instanceof ValidationError) {
          errorMessage = err.message;
        } else {
          errorMessage = 'Failed to load shared design. The URL may be corrupted.';
        }
      }
    }
  });

  function handleViewModeChange(e: CustomEvent<{ mode: ViewMode }>): void {
    viewMode = e.detail.mode;
  }

  async function handleOpenFile(e: CustomEvent<{ file: File }>): Promise<void> {
    errorMessage = '';

    try {
      const loaded = await importFromJSON(e.detail.file);
      openLoaded(loaded);
      adoptIncomingDefinitions($committedLightingData.definitions);
      hasProject = true;

      // Enable lighting stats if there are lights
      if ($committedLightingData.fixtures.length > 0) {
        lightingStatsConfig.update((c) => ({ ...c, visible: true }));
      }

      requestCameraFit();
    } catch (err) {
      if (err instanceof ValidationError) {
        errorMessage = err.message;
      } else {
        errorMessage = 'Failed to load file. Make sure it is a valid LuxDraft JSON export.';
      }
    }
  }

  function handleEmptyStateOpen(): void {
    toolbar?.triggerFileOpen();
  }
</script>

<div class="viewer-page">
  <ViewerToolbar
    bind:this={toolbar}
    {moduleId}
    {viewMode}
    {hasProject}
    on:openFile={handleOpenFile}
    on:viewModeChange={handleViewModeChange}
  />

  <div class="viewer-main">
    {#if hasProject}
      <div class="canvas-area">
        <ViewerCanvas {viewMode} />
        <ViewerStatsPanel />
      </div>
    {:else}
      <div class="empty-state">
        <div class="empty-content">
          <div class="empty-icon">&#128194;</div>
          <h2>No project loaded</h2>
          <p>Open a LuxDraft JSON file to view your lighting design</p>
          <button class="empty-open-btn" on:click={handleEmptyStateOpen}>Open File</button>
        </div>
      </div>
    {/if}

    {#if errorMessage}
      <div class="error-toast">
        <span>{errorMessage}</span>
        <button class="error-close" on:click={() => (errorMessage = '')}>&times;</button>
      </div>
    {/if}
  </div>

  <LightInfoBottomSheet />
</div>

<style>
  .viewer-page {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: var(--input-bg);
  }

  .viewer-main {
    flex: 1;
    position: relative;
    overflow: hidden;
  }

  .canvas-area {
    width: 100%;
    height: 100%;
    position: relative;
  }

  /* Empty state */
  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
  }

  .empty-content {
    text-align: center;
    padding: 32px;
  }

  .empty-icon {
    font-size: 48px;
    margin-bottom: 16px;
    opacity: 0.6;
  }

  .empty-content h2 {
    margin: 0 0 8px;
    font-size: 20px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .empty-content p {
    margin: 0 0 24px;
    font-size: 14px;
    color: var(--text-muted);
  }

  .empty-open-btn {
    padding: 10px 24px;
    background: var(--button-active);
    border: none;
    border-radius: var(--radius-md);
    color: white;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
  }

  .empty-open-btn:hover {
    opacity: 0.9;
  }

  /* Error toast */
  .error-toast {
    position: absolute;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 16px;
    background: var(--status-error);
    color: white;
    border-radius: var(--radius-md);
    font-size: 13px;
    box-shadow: var(--shadow-lg);
    z-index: 100;
    max-width: 90%;
  }

  .error-close {
    background: none;
    border: none;
    color: white;
    font-size: 18px;
    cursor: pointer;
    padding: 0 4px;
    opacity: 0.8;
  }

  .error-close:hover {
    opacity: 1;
  }
</style>
