<script lang="ts">
  import type { OverlayToggle } from '../floorplan/types/moduleRuntime';

  /**
   * One module-contributed overlay toggle.
   *
   * A component rather than markup inside the toolbar's `{#each}` because `$store` only
   * auto-subscribes to a top-level variable — `$overlay.active` is not a thing Svelte can
   * compile. One prop, one subscription, and the toolbar names no module.
   */
  export let overlay: OverlayToggle;

  let active: typeof overlay.active;
  $: active = overlay.active;
</script>

<button
  class="toggle-button"
  class:active={$active}
  on:click={() => overlay.toggle()}
  title={overlay.title}
>
  <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
    {@html overlay.icon}
  </svg>
  <span class="label">{overlay.label}</span>
</button>

<style>
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

  .toggle-button:hover {
    background: var(--button-bg-hover);
    border-color: var(--border-color);
  }

  .toggle-button.active {
    background: var(--button-active);
    border-color: var(--button-active);
    color: var(--text-primary);
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
</style>
