<script lang="ts">
  import FloatingPanel from '../../../floorplan/ui/FloatingPanel.svelte';
  import {
    floorRegions,
    flooringData,
    layoutConfig,
    layoutPanelVisible,
    plankSpec,
    removeFloorDivider,
    setFloorDividerKind,
    setPlank,
    setRegionSurface,
    toggleLayoutPanel,
    updateLayoutConfig,
  } from '../store';
  import type { PlankSpec, StaggerRule, StartCorner, SurfaceKind, TransitionKind } from '../types';
  import {
    PLANK_PRESETS,
    STAGGER_LABELS,
    START_CORNER_LABELS,
    SURFACE_LABELS,
    TRANSITION_LABELS,
  } from '../types';

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
  const surfaceOptions = Object.entries(SURFACE_LABELS) as [SurfaceKind, string][];
  const transitionOptions = Object.entries(TRANSITION_LABELS) as [TransitionKind, string][];

  // Areas and the dividers between them. Both are derived — the list below is a read-out of what
  // `RegionSolver` made of the lines the user drew, not a second copy of them.
  $: solution = $floorRegions;
  $: regions = solution.regions;
  $: unattached = new Set(solution.unattached);

  function setSurface(seed: { x: number; y: number }, e: Event): void {
    setRegionSurface(seed, (e.target as HTMLSelectElement).value as SurfaceKind);
  }

  function setKind(dividerId: string, e: Event): void {
    setFloorDividerKind(dividerId, (e.target as HTMLSelectElement).value as TransitionKind);
  }

  // Dividers in document order — the order the solver applies them in, which is why a T-junction
  // works. `trimmed` is the honest answer to "does this line actually need trim": a divider with
  // the same floor on both sides is a line the user drew and nothing more.
  $: trimmedIds = new Set(solution.transitions.map((t) => t.dividerId));
  $: dividers = $flooringData.dividers;
</script>

<FloatingPanel
  visible={$layoutPanelVisible}
  title="Floor Layout"
  defaultX={16}
  defaultY={60}
  minWidth="204px"
  maxWidth="228px"
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

  <div class="section">
    <div class="section-title">Areas</div>

    {#if regions.length <= 1}
      <p class="hint">
        The whole room is one area. Use the Divider tool (D) to draw where this floor ends and
        another begins.
      </p>
    {:else}
      {#each regions as region, i (`${region.seed.x},${region.seed.y}`)}
        <label class="control-row">
          <span class="area-name">
            Area {i + 1}
            <span class="area-size">{Math.round(region.areaSqft)} sq ft</span>
          </span>
          <select
            class="panel-select"
            value={region.surface}
            on:change={(e) => setSurface(region.seed, e)}
          >
            {#each surfaceOptions as [value, label] (value)}
              <option {value}>{label}</option>
            {/each}
          </select>
        </label>
      {/each}
    {/if}
  </div>

  {#if dividers.length > 0}
    <div class="section">
      <div class="section-title">Transitions</div>

      {#each dividers as divider, i (divider.id)}
        <div class="control-row">
          <span class="area-name">
            Line {i + 1}
            {#if unattached.has(divider.id)}
              <span class="warn">not attached</span>
            {:else if !trimmedIds.has(divider.id)}
              <span class="area-size">no trim needed</span>
            {/if}
          </span>
          <div class="input-group">
            <select
              class="panel-select"
              value={divider.kind}
              on:change={(e) => setKind(divider.id, e)}
            >
              {#each transitionOptions as [value, label] (value)}
                <option {value}>{label}</option>
              {/each}
            </select>
            <button
              class="remove"
              type="button"
              title="Remove this divider"
              on:click={() => removeFloorDivider(divider.id)}>&times;</button
            >
          </div>
        </div>
      {/each}

      {#if unattached.size > 0}
        <p class="hint">
          A line marked <em>not attached</em> no longer reaches a wall — a wall moved out from under it.
          Delete it and draw it again.
        </p>
      {/if}
    </div>
  {/if}

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
    gap: 8px;
    margin-bottom: 6px;
    font-size: 12px;
    color: var(--text-secondary);
    /* Labels wrap before they widen the panel; the controls keep their size. */
    min-width: 0;
  }

  .control-row > span {
    min-width: 0;
  }

  .input-group {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: none;
  }

  .input-group input {
    width: 56px;
  }

  .unit {
    font-size: 11px;
    color: var(--text-muted);
  }

  select {
    max-width: 112px;
    /* Long option text truncates instead of pushing the panel wider. */
    min-width: 0;
    text-overflow: ellipsis;
  }

  .hint {
    margin: 0;
    font-size: 11px;
    line-height: 1.4;
    color: var(--text-muted);
  }

  .area-name {
    display: flex;
    flex-direction: column;
    line-height: 1.3;
  }

  .area-size {
    font-size: 10px;
    color: var(--text-muted);
  }

  .warn {
    font-size: 10px;
    color: #ef4444;
  }

  .remove {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 15px;
    line-height: 1;
    padding: 0 2px;
    color: var(--text-muted);
  }

  .remove:hover {
    color: #ef4444;
  }
</style>
