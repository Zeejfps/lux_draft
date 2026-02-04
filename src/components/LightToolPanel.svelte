<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { activeTool } from '../stores/appStore';
  import { canPlaceLights } from '../stores/roomStore';
  import { lightDefinitions, selectedDefinitionId, setSelectedDefinition, getDefinitionById } from '../stores/lightDefinitionsStore';
  import type { LightDefinition } from '../types';

  const dispatch = createEventDispatcher<{ openLightManager: void }>();

  let definitions: LightDefinition[] = [];
  let currentDefinitionId: string;
  let currentTool: string;
  let canPlace: boolean;

  // Dragging state
  let panelElement: HTMLDivElement;
  let isDragging = false;
  let dragOffset = { x: 0, y: 0 };
  let position = { x: -1, y: -1 }; // -1 means use default CSS position

  $: definitions = $lightDefinitions;
  $: currentDefinitionId = $selectedDefinitionId;
  $: currentTool = $activeTool;
  $: canPlace = $canPlaceLights;
  $: visible = canPlace && currentTool === 'light';

  function handleDefinitionChange(e: Event): void {
    const newDefinitionId = (e.target as HTMLSelectElement).value;
    setSelectedDefinition(newDefinitionId);
  }

  function openLightManager(): void {
    dispatch('openLightManager');
  }

  // Dragging functions
  function handleMouseDown(e: MouseEvent): void {
    // Only drag from the header area
    const target = e.target as HTMLElement;
    if (target.closest('select') || target.closest('button')) return;

    isDragging = true;
    const rect = panelElement.getBoundingClientRect();
    const parentRect = panelElement.parentElement?.getBoundingClientRect() || { left: 0, top: 0 };

    // Initialize position if first drag
    if (position.x === -1) {
      position.x = rect.left - parentRect.left;
      position.y = rect.top - parentRect.top;
    }

    dragOffset.x = e.clientX - rect.left;
    dragOffset.y = e.clientY - rect.top;

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }

  function handleMouseMove(e: MouseEvent): void {
    if (!isDragging || !panelElement.parentElement) return;

    const parentRect = panelElement.parentElement.getBoundingClientRect();
    const panelRect = panelElement.getBoundingClientRect();

    let newX = e.clientX - parentRect.left - dragOffset.x;
    let newY = e.clientY - parentRect.top - dragOffset.y;

    // Constrain to parent bounds
    newX = Math.max(0, Math.min(newX, parentRect.width - panelRect.width));
    newY = Math.max(0, Math.min(newY, parentRect.height - panelRect.height));

    position = { x: newX, y: newY };
  }

  function handleMouseUp(): void {
    isDragging = false;
    window.removeEventListener('mousemove', handleMouseMove);
    window.removeEventListener('mouseup', handleMouseUp);
  }
</script>

{#if visible}
  <div
    class="light-tool-panel"
    class:dragging={isDragging}
    bind:this={panelElement}
    style={position.x >= 0 ? `left: ${position.x}px; top: ${position.y}px;` : ''}
  >
    <div class="panel-header" on:mousedown={handleMouseDown}>
      <h3>Place Light</h3>
      <div class="header-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="3"/>
          <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
        </svg>
      </div>
    </div>

    <div class="panel-content">
      <label class="definition-select">
        <span class="label-text">Light Type</span>
        <select
          value={currentDefinitionId}
          on:change={handleDefinitionChange}
        >
          {#each definitions as def}
            <option value={def.id}>{def.name}</option>
          {/each}
        </select>
      </label>

      <button class="manage-button" on:click={openLightManager}>
        Manage Light Types...
      </button>

      {#if definitions.find(d => d.id === currentDefinitionId)}
        {@const def = definitions.find(d => d.id === currentDefinitionId)}
        <div class="light-specs">
          <div class="spec-header">Specifications</div>
          <div class="spec-row">
            <span>Lumens</span>
            <span>{def?.lumen} lm</span>
          </div>
          <div class="spec-row">
            <span>Beam Angle</span>
            <span>{def?.beamAngle}°</span>
          </div>
          <div class="spec-row">
            <span>Color Temp</span>
            <span>{def?.warmth}K</span>
          </div>
        </div>
      {/if}

      <p class="hint">Click inside the room to place this light</p>
    </div>
  </div>
{/if}

<style>
  .light-tool-panel {
    position: absolute;
    top: 16px;
    left: 16px;
    width: 240px;
    background: rgba(45, 45, 48, 0.95);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.5);
    z-index: 100;
    user-select: none;
  }

  .light-tool-panel.dragging {
    opacity: 0.9;
    cursor: grabbing;
  }

  .panel-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 16px;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 8px 8px 0 0;
    cursor: grab;
    border-bottom: 1px solid var(--border-color);
  }

  .panel-header:active {
    cursor: grabbing;
  }

  .header-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    color: #fbbf24;
  }

  .header-icon svg {
    width: 18px;
    height: 18px;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .panel-content {
    padding: 16px;
  }

  .definition-select {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 12px;
  }

  .label-text {
    font-size: 12px;
    font-weight: 500;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  select {
    width: 100%;
    padding: 8px;
    border: 1px solid var(--input-border);
    border-radius: 4px;
    font-size: 13px;
    background: var(--input-bg);
    color: var(--text-secondary);
    cursor: pointer;
    transition: border-color 0.15s ease;
  }

  select:focus {
    outline: none;
    border-color: var(--button-active);
  }

  select:hover {
    border-color: var(--border-color);
  }

  .manage-button {
    width: 100%;
    padding: 8px;
    margin-bottom: 12px;
    background: var(--button-bg);
    color: var(--text-secondary);
    border: 1px solid var(--border-color);
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .manage-button:hover {
    background: var(--button-bg-hover);
    border-color: var(--text-muted);
  }

  .light-specs {
    background: var(--input-bg);
    border: 1px solid var(--border-color);
    border-radius: 4px;
    padding: 12px;
    margin-bottom: 12px;
  }

  .spec-header {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 8px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--border-color);
  }

  .spec-row {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    padding: 4px 0;
  }

  .spec-row span:first-child {
    color: var(--text-muted);
  }

  .spec-row span:last-child {
    font-weight: 500;
    color: var(--text-primary);
    font-family: monospace;
  }

  .hint {
    margin: 0;
    font-size: 11px;
    color: var(--text-muted);
    text-align: center;
    line-height: 1.4;
    font-style: italic;
    padding: 8px;
    background: rgba(251, 191, 36, 0.1);
    border: 1px solid rgba(251, 191, 36, 0.2);
    border-radius: 4px;
  }
</style>
