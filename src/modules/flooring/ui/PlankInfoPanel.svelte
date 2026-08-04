<script lang="ts">
  import type { Plank } from '../PlankLayoutEngine';
  import FloatingPanel from '../../../floorplan/ui/FloatingPanel.svelte';
  import { measurePlank } from '../plankMeasure';
  import {
    clearBoardPin,
    pinBoardSize,
    pinRejection,
    plankLayout,
    plankSpec,
    selectPlank,
    selectedPlank,
  } from '../store';
  import type { PinKind } from '../types';
  import { formatInches } from './format';

  /**
   * One board's dimensions, for the board that was clicked — and the one place a size can be
   * *asked for* rather than searched for.
   *
   * Every figure is measured off `Plank.corners` by `measurePlank` rather than read from a field,
   * so a piece cut to a diagonal reads out as the trapezoid it is: a long point, a short point and
   * the angle between them — which is what it takes to set a saw — and the area of the outline
   * rather than length times width.
   *
   * The board is a *value* out of the derived floor and the store re-resolves it on every new
   * layout, so widening the plank or nudging the origin updates these numbers in place, and a
   * board that stops existing closes the panel.
   *
   * ## Why the size fields are here and not on the layout panel
   *
   * The advice this replaces was written two lines below: a board ripped under the minimum told
   * the user to "nudge the layout origin or rip the first row too". That is the right advice and
   * the wrong interface — the user knows the number they want and had to search for it by hand,
   * one pixel of origin drag at a time. Typing it against the board that has to be that size is
   * the shortest possible route from the number to the floor, and what gets stored is the
   * *intent* (see `LayoutInputs.pins`), so it survives a stock change rather than being a lookup
   * table for origin drags.
   */

  $: plank = $selectedPlank;
  $: measurements = plank ? measurePlank(plank, $plankLayout.angle) : null;
  $: spec = $plankSpec;
  /**
   * A rip is a board narrower than the stock it came off — the **engine's** answer, not a second
   * one computed here. Recomputing it at `1e-6` disagreed with the engine's physical tolerance on
   * boards a rounding error under the face width: this panel printed `7" from 7"` and offered no
   * field, because the engine had reported an uncut board with no edge to measure from.
   */
  $: ripped = plank?.ripped ?? false;

  /** Where a size can be typed, and — just as important — where it cannot. */
  $: canPinWidth = ripped && plank?.ripEdge != null;
  $: canPinLength = plank?.cutEnd != null;

  /**
   * The seed a pin is anchored to: the centroid of the board's outline.
   *
   * The centroid rather than `center`, which is the *nominal* rectangle's middle and can sit off
   * a board whose end was cut back to a diagonal.
   */
  function seedOf(board: Plank): { x: number; y: number } {
    const n = board.corners.length;
    return {
      x: board.corners.reduce((sum, p) => sum + p.x, 0) / n,
      y: board.corners.reduce((sum, p) => sum + p.y, 0) / n,
    };
  }

  /**
   * Commit a size. The store refuses one the floor cannot hold and says why, so a rejected number
   * never reaches the document — see `pinBoardSize`. The input is put back to what the board
   * actually measures, because leaving a refused figure in the box implies it took.
   */
  function pin(kind: PinKind, edge: 'low' | 'high', e: Event): void {
    const board = plank;
    const input = e.target as HTMLInputElement;
    const value = parseFloat(input.value);
    if (!board || !Number.isFinite(value) || value <= 0) return;
    const measured = kind === 'rip' ? measurements?.widthIn : measurements?.longIn;
    if (!pinBoardSize(kind, { seed: seedOf(board), targetIn: value, edge })) {
      input.value = (measured ?? 0).toFixed(2);
    }
  }

  // A refusal answers one gesture; a new pick is a new gesture and must not inherit it.
  $: if (plank) pinRejection.set(null);

  /**
   * Whether *this* board is the one a pin of that kind currently holds.
   *
   * Off the engine's own answer rather than off a comparison of seeds: the engine resolves a pin
   * by probing where the pinned board should have landed, and a second opinion computed here
   * would be a second place that resolution could disagree.
   */
  $: pinnedIds = new Set($plankLayout.pinnedIds ?? []);
  $: pinnedHere = plank != null && pinnedIds.has(plank.id);
  $: unsatisfied = new Set(
    ($plankLayout.pinsUnsatisfied ?? []).map((ref) => `${ref.kind}:${ref.index}`)
  );

  const PIN_NOUNS: Readonly<Record<PinKind, string>> = { rip: 'width', joint: 'length' };

  /**
   * The pins holding *this* board, off the engine's own resolution.
   *
   * By probe rather than by seed: the engine resolves a pin by asking which board landed where
   * the pin says one should, and a second opinion computed here would be a second place that
   * answer could differ. `pinnedIds` is parallel to `pinSlots`, so an id matching this board
   * names the slot that holds it.
   */
  $: heldHere = ($plankLayout.pinSlots ?? []).filter(
    (slot) => plank != null && pinnedIds.has(plank.id) && slot.reason === null
  );

  /**
   * What the far wall gets, live, while the user types.
   *
   * The two rips of a room sum to a constant — `runLength mod plankWidth` — so pinning one end
   * determines the other exactly. Showing it as a consequence rather than as a surprise is most
   * of the reason to store a pin instead of solving one.
   */
  const mod = (v: number, m: number): number => ((v % m) + m) % m;

  /** A rip of zero is not a sliver, it is a whole board — the room divided evenly. */
  $: complementIn = measurements
    ? mod($plankLayout.ripSumIn - measurements.widthIn, spec.widthIn) || spec.widthIn
    : 0;
</script>

<!--
  `maxWidth` is not optional here even though the panel had gone without one. A floating panel is
  sized by its content and `FloatingPanel` leaves the maximum unset, so a single sentence of prose
  stretches it the width of the viewport — which is what the first hint long enough to matter did.
-->
<FloatingPanel
  visible={plank != null}
  title="Board"
  defaultX={16}
  defaultY={220}
  minWidth="248px"
  maxWidth="288px"
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
        {#if canPinLength && plank.cutEnd}
          <span class="input-group">
            <input
              class="panel-input"
              type="number"
              min="0.25"
              max={spec.lengthIn}
              step="0.25"
              aria-label="Pin this piece's length"
              title="Type the length this piece should be. The joints of its row move to suit; the row above keeps its stagger."
              value={measurements.longIn.toFixed(2)}
              on:change={(e) => pin('joint', plank.cutEnd, e)}
            />
            <span class="unit">in</span>
          </span>
        {:else}
          <span>{formatInches(measurements.longIn)}</span>
        {/if}
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
        {#if canPinWidth && plank.ripEdge}
          <span class="input-group">
            <input
              class="panel-input"
              class:narrow={plank.narrow}
              type="number"
              min="0.25"
              max={spec.widthIn}
              step="0.125"
              aria-label="Pin this row's width"
              title="Type the width this row should be. The whole row grid shifts to suit, and the row at the far wall takes the difference."
              value={measurements.widthIn.toFixed(2)}
              on:change={(e) => pin('rip', plank.ripEdge, e)}
            />
            <span class="unit">in</span>
          </span>
        {:else}
          <span class:narrow={plank.narrow}>
            {formatInches(measurements.widthIn)}
            {#if ripped}<span class="from">from {formatInches(spec.widthIn)}</span>{/if}
          </span>
        {/if}
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

    {#if canPinWidth}
      <p class="panel-hint">
        {formatInches(measurements.widthIn)} here &rarr; {formatInches(complementIn)} at the far wall.
        The two always add up to the same thing, so setting one sets the other.
      </p>
    {/if}

    {#if plank.narrow}
      <p class="panel-hint warning">
        Ripped below {formatInches(spec.minRipWidthIn)} — a sliver. Type the width you want above and
        the far wall takes the difference, so both ends share the shortfall.
      </p>
    {/if}

    {#if !canPinWidth && !canPinLength}
      <!--
        A board with no size to set is the common case, not the error case: only the row against a
        boundary and the piece at the end of a run are free, and everything between them is a whole
        board. Saying so is the difference between a panel that is read-only here and a panel that
        looks broken — which is exactly how it read when it offered nothing and explained nothing.
      -->
      <p class="panel-hint">
        {#if !ripped && !plank.cutEnd}
          A whole board, so there is no size to set — a board in the middle of a run is always full.
          Click the row against a wall to set its width, or the piece at the end of a run to set its
          length.
        {:else}
          Both {ripped ? 'edges' : 'ends'} of this piece are cut to the room, so nothing the layout can
          move would change its size. Try a board with a joint on one {ripped ? 'edge' : 'end'}.
        {/if}
      </p>
    {/if}

    {#if $pinRejection}
      <p class="panel-hint warning">{$pinRejection}</p>
    {/if}

    {#if pinnedHere}
      <div class="pinned">
        <span class="pinned-label">Pinned</span>
        {#each heldHere as slot (`${slot.kind}:${slot.index}`)}
          <button
            type="button"
            class="chip"
            class:miss={unsatisfied.has(`${slot.kind}:${slot.index}`)}
            title="Stop holding this {PIN_NOUNS[slot.kind]}; the floor goes back to deriving it"
            on:click={() => clearBoardPin(slot.kind, slot.index)}
          >
            {PIN_NOUNS[slot.kind]}{#if unsatisfied.has(`${slot.kind}:${slot.index}`)}&nbsp;— not met{/if}&nbsp;&times;
          </button>
        {/each}
      </div>
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

  .input-group {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: none;
  }

  .input-group input {
    /* Five monospace digits, matching the layout panel's fields. */
    width: 58px;
  }

  .unit {
    font-size: 11px;
    color: var(--text-muted);
  }

  /* What is being held, and the only way to let go of it. See `PlankLayout.pinnedIds`. */
  .pinned {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 6px;
    font-size: 11px;
  }

  .pinned-label {
    color: var(--text-muted);
  }

  .chip {
    /* The violet the pinned boards are drawn in, so the chip and the floor read as one thing. */
    border: 1px solid #8b5cf6;
    border-radius: var(--radius-sm);
    background: transparent;
    color: #8b5cf6;
    font-size: 10px;
    line-height: 1.4;
    padding: 1px 5px;
    cursor: pointer;
  }

  .chip:hover {
    background: var(--panel-bg-alt);
  }

  .chip.miss {
    border-color: #d9483b;
    color: #d9483b;
  }
</style>
