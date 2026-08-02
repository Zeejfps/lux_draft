<script lang="ts">
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import { activeTool, viewMode, setActiveTool, setViewMode } from '../floorplan/stores/appStore';
  import { selection, clearSelection } from '../floorplan/stores/selectionStore';
  import { getSelectedVertexIndices } from '../floorplan/types/selection';
  import { CORE_TOOL_SELECT } from '../floorplan/types/state';
  import { activeModule, moduleOverlays, toolbarTools } from '../floorplan/stores/moduleActivation';
  import { NO_ENTITIES } from '../floorplan/types/entity';
  import { committedDocument, resetRoom, openLoaded } from '../floorplan/stores/roomStore';
  import { sessionStore, history, saveInput } from '../floorplan/stores/sessionStore';
  import { canUndo, canRedo, undoLabel, redoLabel } from '../floorplan/types/session';
  import {
    displayPreferences,
    toggleGridSnap,
    cycleLightRadiusVisibility,
  } from '../floorplan/stores/settingsStore';
  import {
    togglePropertiesPanel,
    propertiesPanelConfig,
  } from '../floorplan/stores/propertiesPanelStore';
  import { isMeasuring } from '../floorplan/stores/measurementStore';
  import { exportToJSON } from '../floorplan/persistence/jsonExport';
  import { importFromJSON } from '../floorplan/persistence/jsonImport';
  import { saveNow, clearLocalStorage } from '../floorplan/persistence/localStorage';
  import OverlayToggleButton from './OverlayToggleButton.svelte';
  import ShareDialog from './ShareDialog.svelte';
  import { navigate, PICKER_PATH } from './routerStore';
  import type { Tool, ViewMode, LightRadiusVisibility, EditorDocument } from '../floorplan/types';

  const iconPath = `${import.meta.env.BASE_URL}icons/lux_draft_icon.png`;

  let toolbarElement: HTMLDivElement;

  let fileInput: HTMLInputElement;
  // Save, export and share read the *committed* document, never the live preview.
  let currentRoom: EditorDocument;
  $: currentRoom = $committedDocument;

  const dispatch = createEventDispatcher<{ toggleMeasurement: void }>();

  let currentTool: Tool;
  let currentViewMode: ViewMode;
  let undoEnabled: boolean;
  let redoEnabled: boolean;
  let undoTitle: string;
  let redoTitle: string;
  let propertiesVisible: boolean;
  let gridSnapEnabled: boolean;
  let measuringActive: boolean;
  let canMeasure: boolean;
  let lightRadiusVisibility: LightRadiusVisibility;
  let saveSuccess: boolean = false;
  let shareOpen: boolean = false;

  $: currentTool = $activeTool;
  $: currentViewMode = $viewMode;
  $: undoEnabled = canUndo($history);
  $: redoEnabled = canRedo($history);
  // The label rides with the snapshot, so the tooltip names the edit rather than the verb.
  $: undoTitle = undoEnabled ? `Undo ${undoLabel($history)} (Ctrl+Z)` : 'Undo (Ctrl+Z)';
  $: redoTitle = redoEnabled ? `Redo ${redoLabel($history)} (Ctrl+Y)` : 'Redo (Ctrl+Y)';
  $: propertiesVisible = $propertiesPanelConfig.visible;
  $: gridSnapEnabled = $displayPreferences.gridSnapEnabled;
  $: measuringActive = $isMeasuring;
  // Core's own vertices, plus whatever the active module contributes as point entities.
  $: canMeasure =
    getSelectedVertexIndices($selection).length > 0 ||
    ($activeModule?.entities ?? NO_ENTITIES).selectedIds($selection).length > 0;
  $: lightRadiusVisibility = $displayPreferences.lightRadiusVisibility;

  function handleToolChange(tool: Tool): void {
    // If clicking the already active tool (and it's not select), toggle back to select
    if (currentTool === tool && tool !== 'select') {
      setActiveTool(CORE_TOOL_SELECT);
    } else {
      setActiveTool(tool);
    }
  }

  function handleViewModeChange(mode: ViewMode): void {
    setViewMode(mode);
  }

  function toggleMeasurement(): void {
    dispatch('toggleMeasurement');
  }

  function handleNew(): void {
    // "Is there anything to lose" without naming a module: geometry, or any edit at all.
    if (currentRoom.geometry.boundary.walls.length > 0 || canUndo($history)) {
      if (!confirm('Start a new project? Unsaved changes will be lost.')) {
        return;
      }
    }
    clearLocalStorage();
    // `open` replaces document, selection, interaction and history in one action.
    resetRoom();
    clearSelection();
  }

  function handleSave(): void {
    saveNow($saveInput);
    saveSuccess = true;
    setTimeout(() => {
      saveSuccess = false;
    }, 2000);
  }

  function handleExport(): void {
    exportToJSON($saveInput);
  }

  function handleShare(): void {
    // A link is a single-module view, so the module is a choice rather than a constant.
    shareOpen = true;
  }

  function handleImportClick(): void {
    fileInput.click();
  }

  async function handleFileSelect(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    try {
      const loaded = await importFromJSON(file);
      // The active module adopts anything the incoming document references; the shell no
      // longer knows what "anything" means.
      openLoaded(loaded);
      clearSelection();
    } catch (err) {
      alert(`Import failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }

    input.value = '';
  }

  function handleWheel(e: WheelEvent): void {
    if (!toolbarElement) return;

    // Convert vertical scroll to horizontal scroll
    if (e.deltaY !== 0) {
      e.preventDefault();
      toolbarElement.scrollLeft += e.deltaY;
    }
  }

  onMount(() => {
    if (toolbarElement) {
      toolbarElement.addEventListener('wheel', handleWheel, { passive: false });
    }
  });

  onDestroy(() => {
    if (toolbarElement) {
      toolbarElement.removeEventListener('wheel', handleWheel);
    }
  });
</script>

<input
  type="file"
  accept=".json"
  bind:this={fileInput}
  on:change={handleFileSelect}
  style="display: none"
/>

<div class="toolbar" bind:this={toolbarElement}>
  <div class="toolbar-section branding-section">
    <div class="branding">
      <img src={iconPath} alt="LuxDraft" class="app-icon" />
      <div class="branding-text">
        <h1>LuxDraft</h1>
        <div class="subtitle">Studio <span class="version-badge">{__APP_VERSION__}</span></div>
        <!--
          The mode switcher. The label comes from the active module's manifest, and the button
          goes to the picker route — the shell names no mode.
        -->
        <button
          class="mode-button"
          on:click={() => navigate({ kind: 'picker' })}
          title="Switch mode ({PICKER_PATH})"
        >
          {$activeModule?.label ?? 'Choose a mode'}
          <span class="caret">&#9662;</span>
        </button>
      </div>
    </div>
  </div>

  <div class="toolbar-section">
    <span class="section-label">File</span>
    <div class="button-group">
      <button class="tool-button" on:click={handleNew} title="New Project">
        <svg
          class="icon-svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="12" y1="18" x2="12" y2="12" />
          <line x1="9" y1="15" x2="15" y2="15" />
        </svg>
        <span class="label">New</span>
      </button>
      <button
        class="tool-button"
        class:save-success={saveSuccess}
        on:click={handleSave}
        title="Save to Browser"
      >
        {#if saveSuccess}
          <svg
            class="icon-svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <span class="label">Saved!</span>
        {:else}
          <svg
            class="icon-svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
            <polyline points="17 21 17 13 7 13 7 21" />
            <polyline points="7 3 7 8 15 8" />
          </svg>
          <span class="label">Save</span>
        {/if}
      </button>
      <button class="tool-button" on:click={handleImportClick} title="Import JSON">
        <svg
          class="icon-svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
        <span class="label">Open</span>
      </button>
      <button class="tool-button" on:click={handleExport} title="Export as JSON">
        <svg
          class="icon-svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        <span class="label">Export</span>
      </button>
      <button class="tool-button" on:click={handleShare} title="Copy Share Link">
        <svg
          class="icon-svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <circle cx="18" cy="5" r="3" />
          <circle cx="6" cy="12" r="3" />
          <circle cx="18" cy="19" r="3" />
          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
          <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
        </svg>
        <span class="label">Share</span>
      </button>
      <button
        class="tool-button"
        disabled={!undoEnabled}
        on:click={() => sessionStore.undo()}
        title={undoTitle}
      >
        <svg
          class="icon-svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <polyline points="1 4 1 10 7 10" />
          <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
        </svg>
        <span class="label">Undo</span>
      </button>
      <button
        class="tool-button"
        disabled={!redoEnabled}
        on:click={() => sessionStore.redo()}
        title={redoTitle}
      >
        <svg
          class="icon-svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <polyline points="23 4 23 10 17 10" />
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
        </svg>
        <span class="label">Redo</span>
      </button>
    </div>
  </div>

  <div class="toolbar-section">
    <span class="section-label">Tools</span>
    <div class="button-group">
      <!--
        Every tool comes from the registry: core's three, then the active module's. Nothing in
        this file names a tool, which is what lets a module contribute a button.
      -->
      {#each $toolbarTools as tool (tool.descriptor.id)}
        <button
          class="tool-button"
          class:active={currentTool === tool.descriptor.id}
          on:click={() => handleToolChange(tool.descriptor.id)}
          disabled={!tool.enabled}
          title={tool.enabled
            ? tool.descriptor.title
            : (tool.descriptor.disabledTitle ?? tool.descriptor.title)}
        >
          <svg
            class="icon-svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
            {@html tool.descriptor.icon}
          </svg>
          <span class="label">{tool.descriptor.label}</span>
        </button>
      {/each}
      <div class="section-divider"></div>
      <button
        class="toggle-button modifier"
        class:active={gridSnapEnabled}
        on:click={toggleGridSnap}
        title="Snap to Grid (S)"
      >
        <svg
          class="icon-svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <line x1="3" y1="9" x2="21" y2="9" />
          <line x1="3" y1="15" x2="21" y2="15" />
          <line x1="9" y1="3" x2="9" y2="21" />
          <line x1="15" y1="3" x2="15" y2="21" />
        </svg>
        <span class="label">Snap</span>
      </button>
      <button
        class="toggle-button measuring modifier"
        class:active={measuringActive}
        disabled={!canMeasure}
        on:click={toggleMeasurement}
        title={measuringActive
          ? 'Measuring Active (Press M or ESC to exit)'
          : canMeasure
            ? 'Start Measuring (M)'
            : 'Select a vertex or light first'}
      >
        <svg
          class="icon-svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <path
            d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z"
          />
          <path d="m14.5 12.5 2-2" />
          <path d="m11.5 9.5 2-2" />
          <path d="m8.5 6.5 2-2" />
          <path d="m17.5 15.5 2-2" />
        </svg>
        <span class="label">Measure</span>
      </button>
    </div>
  </div>

  <div class="toolbar-section">
    <span class="section-label">View</span>
    <div class="button-group">
      <button
        class="view-button"
        class:active={currentViewMode === 'editor'}
        on:click={() => handleViewModeChange('editor')}
        title="Layout View (1)"
      >
        <svg
          class="icon-svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <rect x="3" y="3" width="18" height="18" rx="1" />
          <line x1="3" y1="12" x2="14" y2="12" />
          <line x1="14" y1="3" x2="14" y2="12" />
        </svg>
        <span class="label">Layout</span>
      </button>
      <button
        class="view-button"
        class:active={currentViewMode === 'shadow'}
        on:click={() => handleViewModeChange('shadow')}
        title="Shadow View (2)"
      >
        <svg
          class="icon-svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M12 2a10 10 0 0 1 0 20" fill="currentColor" opacity="0.3" />
        </svg>
        <span class="label">Shadow</span>
      </button>
      <button
        class="view-button"
        class:active={currentViewMode === 'heatmap'}
        on:click={() => handleViewModeChange('heatmap')}
        title="Heatmap View (3)"
      >
        <svg
          class="icon-svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <rect x="7" y="7" width="3" height="3" />
          <rect x="14" y="7" width="3" height="3" />
          <rect x="7" y="14" width="3" height="3" />
          <rect x="14" y="14" width="3" height="3" />
        </svg>
        <span class="label">Heatmap</span>
      </button>
    </div>
  </div>

  <div class="toolbar-section">
    <span class="section-label">Overlay</span>
    <div class="button-group">
      <!--
        Overlay toggles come from the active module's manifest. Before phase 5 these were
        hardcoded buttons reading lighting's stores, which is what kept the whole module in
        the eager chunk.
      -->
      {#each $moduleOverlays as overlay (overlay.id)}
        <OverlayToggleButton {overlay} />
      {/each}
      <button
        class="toggle-button"
        class:active={lightRadiusVisibility === 'always'}
        on:click={cycleLightRadiusVisibility}
        title="Cycle Light Radius Visibility"
      >
        <svg
          class="icon-svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <circle cx="12" cy="12" r="10" />
          <circle cx="12" cy="12" r="6" />
          <circle cx="12" cy="12" r="2" />
        </svg>
        <span class="label">Radius</span>
      </button>
    </div>
  </div>

  <div class="toolbar-section">
    <span class="section-label">More</span>
    <div class="button-group">
      <button
        class="toggle-button"
        class:active={propertiesVisible}
        on:click={togglePropertiesPanel}
        title="Toggle Properties Panel (P)"
      >
        <svg
          class="icon-svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="9" y1="3" x2="9" y2="21" />
        </svg>
        <span class="label">Properties</span>
      </button>
    </div>
  </div>
</div>

<ShareDialog visible={shareOpen} on:close={() => (shareOpen = false)} />

<style>
  .toolbar {
    display: flex;
    align-items: stretch;
    gap: var(--spacing-16);
    padding: 6px var(--spacing-16);
    background: var(--panel-bg);
    border-bottom: 1px solid var(--border-color);
    box-shadow: var(--shadow-sm);
    overflow-x: auto;
    overflow-y: hidden;
    /* Hide scrollbar */
    scrollbar-width: none; /* Firefox */
    -ms-overflow-style: none; /* IE/Edge */
  }

  .toolbar::-webkit-scrollbar {
    display: none; /* Chrome/Safari/Opera */
  }

  .toolbar-section {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-4);
    padding-right: var(--spacing-16);
    border-right: 1px solid var(--border-color);
    flex-shrink: 0;
  }

  .toolbar-section:last-child {
    border-right: none;
    padding-right: 0;
  }

  .branding-section {
    padding-left: 0;
    padding-right: var(--spacing-16);
    justify-content: center;
  }

  .branding {
    display: flex;
    align-items: center;
    gap: var(--spacing-8);
    height: 100%;
  }

  .app-icon {
    width: 48px;
    height: 48px;
  }

  .branding-text {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
  }

  h1 {
    margin: 0;
    font-size: 16px;
    font-weight: 700;
    color: var(--text-primary);
    white-space: nowrap;
    line-height: 1;
  }

  .subtitle {
    font-size: 11px;
    color: var(--text-secondary);
    white-space: nowrap;
    display: flex;
    align-items: baseline;
    gap: 4px;
  }

  .version-badge {
    font-size: 9px;
    color: var(--text-muted);
    white-space: nowrap;
  }

  .mode-button {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-top: 2px;
    padding: 2px 6px;
    background: var(--button-bg, transparent);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 11px;
    font-weight: 500;
    white-space: nowrap;
    cursor: pointer;
  }

  .mode-button:hover {
    background: var(--button-bg-hover);
  }

  .caret {
    font-size: 9px;
    color: var(--text-muted);
  }

  .section-label {
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    text-align: center;
  }

  .button-group {
    display: flex;
    gap: 2px;
    flex: 1;
    align-items: center;
  }

  .section-divider {
    width: 1px;
    height: 40px;
    background: var(--border-color);
    margin: 0 var(--spacing-4);
    flex-shrink: 0;
  }

  .modifier {
    opacity: 0.85;
  }

  .modifier:hover:not(:disabled) {
    opacity: 1;
  }

  .tool-button,
  .view-button,
  .toggle-button {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--spacing-4);
    padding: var(--spacing-8) var(--spacing-12);
    min-width: 56px;
    min-height: 54px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-secondary);
    font-size: 11px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .tool-button:hover:not(:disabled),
  .view-button:hover,
  .toggle-button:hover {
    background: var(--button-bg-hover);
    border-color: var(--border-color);
  }

  .tool-button.active,
  .view-button.active,
  .toggle-button.active {
    background: var(--button-active);
    border-color: var(--button-active);
    color: var(--text-primary);
  }

  .tool-button.save-success {
    background: var(--status-success);
    border-color: var(--status-success);
    color: white;
  }

  .tool-button:disabled,
  .toggle-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .icon-svg {
    width: 20px;
    height: 20px;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .label {
    white-space: nowrap;
  }

  .toggle-button.measuring.active {
    background: var(--measurement-active);
    border-color: var(--measurement-active);
    color: var(--text-primary);
    animation: pulse 2s infinite;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.8;
    }
  }

  .toggle-button.measuring:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .toggle-button.measuring:not(.active):not(:disabled) {
    background: transparent;
    border-color: transparent;
    color: var(--text-secondary);
  }

  .toggle-button.measuring:not(.active):not(:disabled):hover {
    background: var(--button-bg-hover);
    border-color: var(--border-color);
  }
</style>
