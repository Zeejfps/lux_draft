<script lang="ts">
  import FloatingPanel from '../../../floorplan/ui/FloatingPanel.svelte';
  import { selection } from '../../../floorplan/stores/selectionStore';
  import { isOriginSelected } from '../selection';
  import { committedFlooringData, layoutConfig, setOrigin, updateLayoutConfig } from '../store';

  /**
   * The property panel for the layout origin.
   *
   * Registered under `originSelection.panelKey` (`flooring.origin`) and mounted by the panel
   * registry when that selection is live — including when the origin was picked up by a box
   * drag alongside room vertices, because `SelectionKind.match` looks inside a `multi`.
   */

  $: visible = isOriginSelected($selection);
  $: origin = $committedFlooringData.origin;
  $: layout = $layoutConfig;

  function setCoordinate(axis: 'x' | 'y', e: Event): void {
    const value = parseFloat((e.target as HTMLInputElement).value);
    if (!Number.isFinite(value)) return;
    setOrigin({ ...origin, [axis]: value });
  }

  function setAngle(e: Event): void {
    const value = parseFloat((e.target as HTMLInputElement).value);
    if (Number.isFinite(value)) updateLayoutConfig({ runAngleDeg: value });
  }
</script>

<FloatingPanel
  {visible}
  title="Layout Origin"
  defaultX={16}
  defaultY={160}
  minWidth="212px"
  persistenceKey="flooring-origin-panel"
>
  <div class="panel-row">
    <span>X</span>
    <input
      class="panel-input"
      type="number"
      step="0.25"
      value={origin.x.toFixed(2)}
      on:change={(e) => setCoordinate('x', e)}
    />
  </div>
  <div class="panel-row">
    <span>Y</span>
    <input
      class="panel-input"
      type="number"
      step="0.25"
      value={origin.y.toFixed(2)}
      on:change={(e) => setCoordinate('y', e)}
    />
  </div>
  <div class="panel-row">
    <span>Run angle</span>
    <input
      class="panel-input"
      type="number"
      min="0"
      max="180"
      step="5"
      value={Math.round(layout.runAngleDeg)}
      on:change={setAngle}
    />
  </div>

  <p class="panel-hint">
    Every row and every plank joint is measured from this point. Drag it, or nudge it with the grab
    tool, and the whole floor re-derives.
  </p>
</FloatingPanel>

<style>
  .panel-row input {
    width: 92px;
  }
</style>
