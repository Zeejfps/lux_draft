<script lang="ts">
  import FloatingPanel from '../../../floorplan/ui/FloatingPanel.svelte';
  import { measurePlank } from '../plankMeasure';
  import { plankLayout, plankSpec, selectPlank, selectedPlank } from '../store';
  import { formatInches } from './format';

  /**
   * One board's dimensions, for the board that was clicked.
   *
   * Every figure is measured off `Plank.corners` by `measurePlank` rather than read from a field,
   * so a piece cut to a diagonal reads out as the trapezoid it is: a long point, a short point and
   * the angle between them — which is what it takes to set a saw — and the area of the outline
   * rather than length times width.
   *
   * The board is a *value* out of the derived floor and the store re-resolves it on every new
   * layout, so widening the plank or nudging the origin updates these numbers in place, and a
   * board that stops existing closes the panel.
   */

  $: plank = $selectedPlank;
  $: measurements = plank ? measurePlank(plank, $plankLayout.angle) : null;
  $: spec = $plankSpec;
  /** A rip is a board narrower than the stock it came off. */
  $: ripped = measurements ? measurements.widthIn < spec.widthIn - 1e-6 : false;
</script>

<FloatingPanel
  visible={plank != null}
  title="Board"
  defaultX={16}
  defaultY={220}
  minWidth="248px"
  persistenceKey="flooring-board-panel"
  showCloseButton={true}
  onClose={() => selectPlank(null)}
>
  {#if plank && measurements}
    <div class="headline">
      <span class="dims">
        {formatInches(measurements.longIn)} &times; {formatInches(measurements.widthIn)}
      </span>
      <span class="where">Row {plank.row}, board {plank.column + 1}</span>
    </div>

    <div class="panel-info-box">
      <div class="panel-info-row">
        <span>Length</span>
        <span>{formatInches(measurements.longIn)}</span>
      </div>
      {#if measurements.mitred}
        <!-- Only for a board with an end off square: for every other one the short point is the
             length again and the angle is zero, which is two rows saying nothing. -->
        <div class="panel-info-row">
          <span>Short point</span>
          <span>{formatInches(measurements.shortIn)}</span>
        </div>
        <div class="panel-info-row">
          <span>Mitre</span>
          <span>{measurements.angleDeg.toFixed(1)}&deg; off square</span>
        </div>
      {/if}
      <div class="panel-info-row">
        <span>Width</span>
        <span class:narrow={plank.narrow}>
          {formatInches(measurements.widthIn)}
          {#if ripped}<span class="from">from {formatInches(spec.widthIn)}</span>{/if}
        </span>
      </div>
      <div class="panel-info-row">
        <span>Area</span>
        <span>{measurements.areaSqft.toFixed(2)} sq ft</span>
      </div>
      <div class="panel-info-row">
        <span>Piece</span>
        <span>{plank.cut ? 'Cut' : 'Full board'}</span>
      </div>
    </div>

    {#if plank.narrow}
      <p class="panel-hint warning">
        Ripped below {formatInches(spec.minRipWidthIn)} — a sliver. Nudge the layout origin or rip the
        first row too, so both ends take half the shortfall.
      </p>
    {/if}
  {/if}
</FloatingPanel>

<style>
  .headline {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-bottom: 4px;
  }

  .dims {
    font-size: 16px;
    font-weight: 600;
    font-family: monospace;
    color: var(--text-primary);
  }

  .where {
    font-size: 11px;
    color: var(--text-muted);
  }

  .from {
    color: var(--text-muted);
    font-weight: 400;
  }

  /* The red the flagged boards are drawn in. */
  .narrow {
    color: #d9483b;
  }
</style>
