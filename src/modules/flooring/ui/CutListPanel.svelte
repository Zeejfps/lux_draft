<script lang="ts">
  import FloatingPanel from '../../../floorplan/ui/FloatingPanel.svelte';
  import { roomStore } from '../../../floorplan/stores/sessionStore';
  import {
    committedFlooringData,
    hoveredPlank,
    plankLayout,
    plankSpec,
    removeDoorTransition,
    summaryVisible,
    toggleSummary,
  } from '../store';
  import { liveTransitions } from '../codec';
  import { TRANSITION_LABELS } from '../types';

  /**
   * The estimate: cut list, waste and the doorways being trimmed.
   *
   * Everything numeric here comes from `$plankLayout`, which is the projection's output and is
   * never persisted (invariant 5). Saving the document and reloading it reproduces these
   * figures exactly, because they are a pure function of what *was* saved.
   */

  $: layout = $plankLayout;
  $: plank = $plankSpec;
  $: doors = $roomStore.geometry.doors;
  $: transitions = liveTransitions($committedFlooringData.transitions, doors);

  /** 23.5 -> `23 1/2"`. A cut list is read off a tape measure, not a calculator. */
  function inches(value: number): string {
    const whole = Math.floor(value + 1e-9);
    const eighths = Math.round((value - whole) * 8);
    if (eighths === 0) return `${whole}"`;
    if (eighths === 8) return `${whole + 1}"`;
    const numerator = eighths;
    const denominator = 8;
    const divisor = numerator % 4 === 0 ? 4 : numerator % 2 === 0 ? 2 : 1;
    return `${whole} ${numerator / divisor}/${denominator / divisor}"`;
  }

  function sqft(value: number): string {
    return value.toLocaleString(undefined, { maximumFractionDigits: 1 });
  }

  function doorLabel(doorId: string): string {
    const index = doors.findIndex((d) => d.id === doorId);
    return index >= 0 ? `Door ${index + 1}` : 'Door';
  }
</script>

<FloatingPanel
  visible={$summaryVisible}
  title="Cut List &amp; Waste"
  defaultX={16}
  defaultY={300}
  minWidth="272px"
  maxHeight="calc(100vh - 340px)"
  persistenceKey="flooring-cutlist-panel"
  showCloseButton={true}
  onClose={toggleSummary}
>
  {#if layout.planks.length === 0}
    <p class="empty">Close the room to lay a floor.</p>
  {:else}
    <div class="totals">
      <div class="total">
        <span class="total-value">{sqft(layout.coveredSqft)}</span>
        <span class="total-label">sq ft floor</span>
      </div>
      <div class="total">
        <span class="total-value">{layout.purchasedPlanks}</span>
        <span class="total-label">boards to buy</span>
      </div>
      <div class="total">
        <span class="total-value" class:high={layout.wastePercent > 15}>
          {layout.wastePercent.toFixed(1)}%
        </span>
        <span class="total-label">waste</span>
      </div>
    </div>

    <div class="panel-info-box">
      <div class="panel-info-row"><span>Plank</span><span>{plank.name}</span></div>
      <div class="panel-info-row"><span>Full boards</span><span>{layout.fullPieces}</span></div>
      <div class="panel-info-row"><span>Cut pieces</span><span>{layout.cutPieces}</span></div>
      <div class="panel-info-row">
        <span>Purchased area</span><span>{sqft(layout.purchasedSqft)} sq ft</span>
      </div>
    </div>

    {#if layout.truncated}
      <p class="panel-hint warning">
        This layout hit the plank limit. Increase the plank size to get a complete estimate.
      </p>
    {/if}

    <div class="section-title">Cut list</div>
    <div class="cut-list">
      {#each layout.cutList as entry (`${entry.lengthIn}/${entry.shortIn ?? ''}/${entry.angleDeg ?? ''}`)}
        <div class="cut-row">
          <span class="cut-length">
            {#if entry.shortIn != null}
              <!-- Long point, short point and the angle: what it takes to set a saw. -->
              {inches(entry.lengthIn)} &rarr; {inches(entry.shortIn)} @ {entry.angleDeg}&deg;
            {:else}
              {inches(entry.lengthIn)}
            {/if}
          </span>
          <span class="cut-count">&times; {entry.count}</span>
        </div>
      {:else}
        <p class="empty">No cuts — every board runs full length.</p>
      {/each}
    </div>

    <div class="section-title">Transitions</div>
    {#if transitions.length === 0}
      <p class="empty">Pick the transition tool and click a doorway to trim it.</p>
    {:else}
      <div class="cut-list">
        {#each transitions as transition (transition.id)}
          <div class="cut-row">
            <span class="cut-length">{doorLabel(transition.doorId)}</span>
            <span class="cut-count">{TRANSITION_LABELS[transition.kind]}</span>
            <button
              class="remove"
              title="Remove transition"
              on:click={() => removeDoorTransition(transition.id)}>&times;</button
            >
          </div>
        {/each}
      </div>
    {/if}

    {#if $hoveredPlank}
      <div class="hovered">
        Row {$hoveredPlank.row}, board {$hoveredPlank.column + 1} &mdash;
        {inches($hoveredPlank.length * 12)}
        {$hoveredPlank.cut ? '(cut)' : '(full)'}
      </div>
    {/if}
  {/if}
</FloatingPanel>

<style>
  .totals {
    display: flex;
    gap: 8px;
    margin-bottom: 12px;
  }

  .total {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 8px 4px;
    background: var(--input-bg);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-sm, 4px);
  }

  .total-value {
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .total-value.high {
    color: var(--status-warning, #f59e0b);
  }

  .total-label {
    font-size: 10px;
    color: var(--text-muted);
    text-align: center;
  }

  .section-title {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    margin: 12px 0 6px;
  }

  .cut-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .cut-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 12px;
    padding: 3px 0;
    border-bottom: 1px solid var(--border-color);
  }

  .cut-length {
    font-family: monospace;
    color: var(--text-primary);
  }

  .cut-count {
    color: var(--text-muted);
  }

  .remove {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 15px;
    line-height: 1;
    padding: 0 2px;
  }

  .remove:hover {
    color: var(--status-error);
  }

  .empty {
    margin: 0;
    font-size: 12px;
    color: var(--text-muted);
  }

  .hovered {
    margin-top: 10px;
    padding: 6px 8px;
    background: var(--input-bg);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-sm, 4px);
    font-size: 11px;
    font-family: monospace;
    color: var(--text-secondary);
  }
</style>
