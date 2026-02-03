<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { activeTool, viewMode, setActiveTool, setViewMode, selectedVertexIndex, selectedLightId } from '../stores/appStore';
  import { canPlaceLights } from '../stores/roomStore';
  import { toggleRafters, rafterConfig, displayPreferences, toggleUnitFormat } from '../stores/settingsStore';
  import { toggleLightingStats, lightingStatsConfig } from '../stores/lightingStatsStore';
  import { toggleDeadZones, deadZoneConfig } from '../stores/deadZoneStore';
  import { toggleSpacingWarnings, spacingConfig } from '../stores/spacingStore';
  import { historyStore, canUndo, canRedo } from '../stores/historyStore';
  import { isMeasuring } from '../stores/measurementStore';
  import type { Tool, ViewMode, LightRadiusVisibility } from '../types';

  const dispatch = createEventDispatcher<{ toggleMeasurement: void }>();

  let currentTool: Tool;
  let currentViewMode: ViewMode;
  let lightsEnabled: boolean;
  let raftersVisible: boolean;
  let undoEnabled: boolean;
  let redoEnabled: boolean;
  let unitFormat: 'feet-inches' | 'inches';
  let statsVisible: boolean;
  let deadZonesEnabled: boolean;
  let spacingEnabled: boolean;
  let gridSnapEnabled: boolean;
  let measuringActive: boolean;
  let canMeasure: boolean;
  let lightRadiusVisibility: LightRadiusVisibility;

  $: currentTool = $activeTool;
  $: currentViewMode = $viewMode;
  $: lightsEnabled = $canPlaceLights;
  $: raftersVisible = $rafterConfig.visible;
  $: undoEnabled = $canUndo;
  $: redoEnabled = $canRedo;
  $: unitFormat = $displayPreferences.unitFormat;
  $: statsVisible = $lightingStatsConfig.visible;
  $: deadZonesEnabled = $deadZoneConfig.enabled;
  $: spacingEnabled = $spacingConfig.enabled;
  $: gridSnapEnabled = $displayPreferences.gridSnapEnabled;
  $: measuringActive = $isMeasuring;
  $: canMeasure = $selectedVertexIndex !== null || $selectedLightId !== null;
  $: lightRadiusVisibility = $displayPreferences.lightRadiusVisibility;

  function handleToolChange(tool: Tool): void {
    setActiveTool(tool);
  }

  function handleViewModeChange(mode: ViewMode): void {
    setViewMode(mode);
  }

  function toggleGridSnap(): void {
    displayPreferences.update(p => ({ ...p, gridSnapEnabled: !p.gridSnapEnabled }));
  }

  function toggleMeasurement(): void {
    dispatch('toggleMeasurement');
  }

  function cycleLightRadiusVisibility(): void {
    displayPreferences.update(p => {
      let newVisibility: LightRadiusVisibility;
      if (p.lightRadiusVisibility === 'selected') {
        newVisibility = 'always';
      } else if (p.lightRadiusVisibility === 'always') {
        newVisibility = 'never';
      } else {
        newVisibility = 'selected';
      }
      return { ...p, lightRadiusVisibility: newVisibility };
    });
  }

  function getRadiusVisibilityLabel(visibility: LightRadiusVisibility): string {
    switch (visibility) {
      case 'selected': return 'Radius: Selected';
      case 'always': return 'Radius: Always';
      case 'never': return 'Radius: Hidden';
      default: return 'Radius';
    }
  }
</script>

<div class="toolbar">
  <div class="toolbar-section">
    <div class="button-group">
      <button
        class="icon-button"
        disabled={!undoEnabled}
        on:click={() => historyStore.undo()}
        title="Undo (Ctrl+Z)"
      >
        ↶
      </button>
      <button
        class="icon-button"
        disabled={!redoEnabled}
        on:click={() => historyStore.redo()}
        title="Redo (Ctrl+Y)"
      >
        ↷
      </button>
    </div>
  </div>

  <div class="toolbar-section">
    <span class="section-label">Tools</span>
    <div class="button-group">
      <button
        class="tool-button"
        class:active={currentTool === 'select'}
        on:click={() => handleToolChange('select')}
        title="Select (V)"
      >
        <span class="icon">↖</span>
        <span class="label">Select</span>
      </button>
      <button
        class="tool-button"
        class:active={currentTool === 'draw'}
        on:click={() => handleToolChange('draw')}
        title="Draw Walls (D)"
      >
        <span class="icon">✏</span>
        <span class="label">Draw</span>
      </button>
      <button
        class="tool-button"
        class:active={currentTool === 'light'}
        on:click={() => handleToolChange('light')}
        disabled={!lightsEnabled}
        title={lightsEnabled ? 'Place Lights (L)' : 'Close room first'}
      >
        <span class="icon">💡</span>
        <span class="label">Light</span>
      </button>
      <button
        class="toggle-button"
        class:active={gridSnapEnabled}
        on:click={toggleGridSnap}
        title="Snap to Grid (S)"
      >
        <span class="icon">#</span>
        <span class="label">Snap</span>
      </button>
      <button
        class="toggle-button measuring"
        class:active={measuringActive}
        disabled={!canMeasure}
        on:click={toggleMeasurement}
        title={measuringActive ? "Measuring Active (Press M or ESC to exit)" : canMeasure ? "Start Measuring (M)" : "Select a vertex or light first"}
      >
        <span class="icon">📏</span>
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
        title="Editor View (1)"
      >
        <span class="icon">✎</span>
        <span class="label">Editor</span>
      </button>
      <button
        class="view-button"
        class:active={currentViewMode === 'shadow'}
        on:click={() => handleViewModeChange('shadow')}
        title="Shadow View (2)"
      >
        <span class="icon">◐</span>
        <span class="label">Shadow</span>
      </button>
      <button
        class="view-button"
        class:active={currentViewMode === 'heatmap'}
        on:click={() => handleViewModeChange('heatmap')}
        title="Heatmap View (3)"
      >
        <span class="icon">▦</span>
        <span class="label">Heatmap</span>
      </button>
    </div>
  </div>

  <div class="toolbar-section">
    <span class="section-label">Overlay</span>
    <div class="button-group">
      <button
        class="toggle-button"
        class:active={raftersVisible}
        on:click={toggleRafters}
        title="Toggle Rafters (R)"
      >
        <span class="icon">⊞</span>
        <span class="label">Rafters</span>
      </button>
      <button
        class="toggle-button"
        class:active={deadZonesEnabled}
        on:click={toggleDeadZones}
        title="Toggle Dead Zones"
      >
        <span class="icon">⚠</span>
        <span class="label">Dead Zones</span>
      </button>
      <button
        class="toggle-button"
        class:active={spacingEnabled}
        on:click={toggleSpacingWarnings}
        title="Toggle Spacing Warnings"
      >
        <span class="icon">↔</span>
        <span class="label">Spacing</span>
      </button>
      <button
        class="toggle-button"
        class:active={lightRadiusVisibility === 'always'}
        on:click={cycleLightRadiusVisibility}
        title="Cycle Light Radius Visibility"
      >
        <span class="icon">◎</span>
        <span class="label">Radius</span>
      </button>
    </div>
  </div>

  <div class="toolbar-section">
    <span class="section-label">Analysis</span>
    <button
      class="toggle-button"
      class:active={statsVisible}
      on:click={toggleLightingStats}
      title="Toggle Lighting Stats (Q)"
    >
      <span class="icon">📊</span>
      <span class="label">Stats</span>
    </button>
  </div>

  <div class="toolbar-section">
    <span class="section-label">Units</span>
    <button
      class="toggle-button"
      on:click={toggleUnitFormat}
      title="Toggle Units (U)"
    >
      <span class="icon">📐</span>
      <span class="label">{unitFormat === 'feet-inches' ? "ft' in\"" : 'in"'}</span>
    </button>
  </div>
</div>

<style>
  .toolbar {
    display: flex;
    align-items: stretch;
    gap: 16px;
    padding: 6px 16px;
    background: var(--panel-bg);
    border-bottom: 1px solid var(--border-color);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  }

  .toolbar-section {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-right: 16px;
    border-right: 1px solid var(--border-color);
  }

  .toolbar-section:last-child {
    border-right: none;
    padding-right: 0;
  }

  .section-label {
    font-size: 10px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    text-align: center;
  }

  .button-group {
    display: flex;
    gap: 2px;
    flex: 1;
  }

  .tool-button,
  .view-button,
  .toggle-button {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 8px 12px;
    min-width: 56px;
    min-height: 54px;
    border: 1px solid transparent;
    border-radius: 4px;
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

  .tool-button:disabled,
  .toggle-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .icon {
    font-size: 20px;
    line-height: 1;
  }

  .label {
    white-space: nowrap;
  }

  .icon-button {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    width: 44px;
    min-height: 54px;
    padding: 8px 4px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 20px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .icon-button:hover:not(:disabled) {
    background: var(--button-bg-hover);
    border-color: var(--border-color);
  }

  .icon-button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .toggle-button.measuring.active {
    background: #ff9500;
    border-color: #ff9500;
    color: var(--text-primary);
    animation: pulse 2s infinite;
  }

  @keyframes pulse {
    0%, 100% {
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
