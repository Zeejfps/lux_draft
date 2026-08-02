<script lang="ts">
  import FloatingPanel from '../../../floorplan/ui/FloatingPanel.svelte';
  import {
    layoutConfig,
    layoutPanelVisible,
    plankSpec,
    setPlank,
    toggleLayoutPanel,
    updateLayoutConfig,
  } from '../store';
  import type { PlankSpec, StaggerRule, StartCorner } from '../types';
  import { PLANK_PRESETS, STAGGER_LABELS, START_CORNER_LABELS } from '../types';

  /**
   * The module's authoring surface: the plank being installed and how it is laid.
   *
   * Every control here is one dispatch of one registered command, so every change is one undo
   * entry named for what the user did ("Change plank size", "Change floor layout") — and the
   * floor itself never appears in the document, only in what this panel's inputs derive.
   */

  $: plank = $plankSpec;
  $: layout = $layoutConfig;

  $: presetLabel =
    PLANK_PRESETS.find((p) => p.widthIn === plank.widthIn && p.lengthIn === plank.lengthIn)?.name ??
    'custom';

  function applyPreset(e: Event): void {
    const name = (e.target as HTMLSelectElement).value;
    const preset = PLANK_PRESETS.find((p) => p.name === name);
    if (preset) setPlank({ ...preset });
  }

  function setPlankField(field: 'widthIn' | 'lengthIn', e: Event): void {
    const value = parseFloat((e.target as HTMLInputElement).value);
    if (!Number.isFinite(value) || value <= 0) return;
    const next: PlankSpec = { ...plank, [field]: value };
    next.name = `${next.widthIn}" x ${next.lengthIn}"`;
    setPlank(next);
  }

  function setNumber(field: 'runAngleDeg' | 'minEndCutIn' | 'expansionGapIn' | 'seed', e: Event) {
    const value = parseFloat((e.target as HTMLInputElement).value);
    if (!Number.isFinite(value)) return;
    updateLayoutConfig({ [field]: value });
  }

  function setStagger(e: Event): void {
    updateLayoutConfig({ stagger: (e.target as HTMLSelectElement).value as StaggerRule });
  }

  function setCorner(e: Event): void {
    updateLayoutConfig({ startCorner: (e.target as HTMLSelectElement).value as StartCorner });
  }

  const staggerOptions = Object.entries(STAGGER_LABELS) as [StaggerRule, string][];
  const cornerOptions = Object.entries(START_CORNER_LABELS) as [StartCorner, string][];
</script>

<FloatingPanel
  visible={$layoutPanelVisible}
  title="Floor Layout"
  defaultX={16}
  defaultY={60}
  minWidth="248px"
  persistenceKey="flooring-layout-panel"
  showCloseButton={true}
  onClose={toggleLayoutPanel}
>
  <div class="section">
    <div class="section-title">Plank</div>

    <label class="control-row">
      <span>Preset</span>
      <select class="panel-select" value={presetLabel} on:change={applyPreset}>
        {#if presetLabel === 'custom'}
          <option value="custom">Custom</option>
        {/if}
        {#each PLANK_PRESETS as preset (preset.name)}
          <option value={preset.name}>{preset.name}</option>
        {/each}
      </select>
    </label>

    <label class="control-row">
      <span>Width</span>
      <div class="input-group">
        <input
          class="panel-input"
          type="number"
          min="1"
          max="24"
          step="0.25"
          value={plank.widthIn}
          on:change={(e) => setPlankField('widthIn', e)}
        />
        <span class="unit">in</span>
      </div>
    </label>

    <label class="control-row">
      <span>Length</span>
      <div class="input-group">
        <input
          class="panel-input"
          type="number"
          min="6"
          max="144"
          step="1"
          value={plank.lengthIn}
          on:change={(e) => setPlankField('lengthIn', e)}
        />
        <span class="unit">in</span>
      </div>
    </label>
  </div>

  <div class="section">
    <div class="section-title">Run</div>

    <label class="control-row">
      <span>Angle</span>
      <div class="input-group">
        <input
          class="panel-input"
          type="number"
          min="0"
          max="180"
          step="5"
          value={Math.round(layout.runAngleDeg)}
          on:change={(e) => setNumber('runAngleDeg', e)}
        />
        <span class="unit">&deg;</span>
      </div>
    </label>

    <label class="control-row">
      <span>Start corner</span>
      <select class="panel-select" value={layout.startCorner} on:change={setCorner}>
        {#each cornerOptions as [value, label] (value)}
          <option {value}>{label}</option>
        {/each}
      </select>
    </label>

    <label class="control-row">
      <span>Stagger</span>
      <select class="panel-select" value={layout.stagger} on:change={setStagger}>
        {#each staggerOptions as [value, label] (value)}
          <option {value}>{label}</option>
        {/each}
      </select>
    </label>

    {#if layout.stagger === 'random'}
      <label class="control-row">
        <span>Seed</span>
        <div class="input-group">
          <input
            class="panel-input"
            type="number"
            step="1"
            value={layout.seed}
            on:change={(e) => setNumber('seed', e)}
          />
        </div>
      </label>
    {/if}
  </div>

  <div class="section">
    <div class="section-title">Cuts</div>

    <label class="control-row">
      <span>Min end cut</span>
      <div class="input-group">
        <input
          class="panel-input"
          type="number"
          min="0"
          max="36"
          step="0.5"
          value={layout.minEndCutIn}
          on:change={(e) => setNumber('minEndCutIn', e)}
        />
        <span class="unit">in</span>
      </div>
    </label>

    <label class="control-row">
      <span>Expansion gap</span>
      <div class="input-group">
        <input
          class="panel-input"
          type="number"
          min="0"
          max="2"
          step="0.125"
          value={layout.expansionGapIn}
          on:change={(e) => setNumber('expansionGapIn', e)}
        />
        <span class="unit">in</span>
      </div>
    </label>
  </div>

  <p class="hint">
    Drag the blue origin marker to move the starting corner. The floor is re-derived, never stored.
  </p>
</FloatingPanel>

<style>
  .section {
    margin-bottom: 14px;
  }

  .section:last-of-type {
    margin-bottom: 6px;
  }

  .section-title {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    margin-bottom: 6px;
  }

  .control-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 6px;
    font-size: 12px;
    color: var(--text-secondary);
  }

  .input-group {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .input-group input {
    width: 72px;
  }

  .unit {
    font-size: 11px;
    color: var(--text-muted);
  }

  select {
    max-width: 148px;
  }

  .hint {
    margin: 0;
    font-size: 11px;
    line-height: 1.4;
    color: var(--text-muted);
  }
</style>
