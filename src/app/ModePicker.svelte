<script lang="ts">
  import { registeredModules } from '../floorplan/types/moduleRegistry';
  import { navigate } from './routerStore';

  /**
   * The landing route: pick a mode.
   *
   * `registeredModules()` returns codec + label + `loadRuntime` for every installed module, so
   * the picker lists every mode **without loading a single runtime** — which is the point of
   * splitting the manifest into an eager and a lazy half.
   */
  const modes = registeredModules().map((definition) => ({
    id: definition.codec.id,
    label: definition.label,
  }));

  const iconPath = `${import.meta.env.BASE_URL}icons/lux_draft_icon.png`;

  function open(moduleId: string): void {
    navigate({ kind: 'editor', moduleId });
  }
</script>

<div class="picker">
  <div class="picker-inner">
    <div class="branding">
      <img src={iconPath} alt="LuxDraft" class="app-icon" />
      <div>
        <h1>LuxDraft Studio</h1>
        <p class="subtitle">One room, one drawing, one mode at a time.</p>
      </div>
    </div>

    <div class="modes">
      {#each modes as mode (mode.id)}
        <button class="mode-card" on:click={() => open(mode.id)}>
          <span class="mode-label">{mode.label}</span>
          <span class="mode-hint">#/{mode.id}</span>
        </button>
      {/each}
    </div>

    {#if modes.length === 0}
      <p class="empty">No modes are installed in this build.</p>
    {/if}
  </div>
</div>

<style>
  .picker {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100vh;
    background: var(--input-bg);
  }

  .picker-inner {
    width: min(560px, 90vw);
  }

  .branding {
    display: flex;
    align-items: center;
    gap: var(--spacing-16);
    margin-bottom: 32px;
  }

  .app-icon {
    width: 56px;
    height: 56px;
  }

  h1 {
    margin: 0;
    font-size: 22px;
    font-weight: 700;
    color: var(--text-primary);
  }

  .subtitle {
    margin: 4px 0 0;
    font-size: 13px;
    color: var(--text-muted);
  }

  .modes {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: var(--spacing-12);
  }

  .mode-card {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--spacing-4);
    padding: 20px;
    background: var(--panel-bg);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-lg);
    cursor: pointer;
    text-align: left;
    transition: all 0.15s ease;
  }

  .mode-card:hover {
    border-color: var(--button-active);
    background: var(--button-bg-hover);
  }

  .mode-label {
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .mode-hint {
    font-size: 11px;
    font-family: monospace;
    color: var(--text-muted);
  }

  .empty {
    font-size: 13px;
    color: var(--text-muted);
  }
</style>
