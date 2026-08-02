<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { registeredModules } from '../floorplan/types/moduleRegistry';
  import { activeModule } from '../floorplan/stores/moduleActivation';
  import { saveInput } from '../floorplan/stores/sessionStore';
  import { generateShareUrl } from '../floorplan/persistence/shareUrl';
  import { DEFAULT_MODULE_ID } from './routerStore';

  /**
   * The share dialog picks the module explicitly.
   *
   * A share link is a single-module view: the chosen module's slice runs through its own
   * `compactForShare` and every other live slice — plus every quarantined blob — is omitted by
   * `encodeDocument`. The module is in the path (`#/{moduleId}/viewer`) rather than inferred
   * from persisted UI state, because UI state does not travel with a link.
   *
   * A module whose data this build could not decode is **not shareable**: the recipient would
   * get a link that fails on open. `encodeDocument` throws for one; the dialog disables it
   * first so nobody has to read the exception.
   */
  export let visible: boolean = false;

  const dispatch = createEventDispatcher<{ close: void }>();

  /**
   * A link opens the viewer, so a mode with no viewer cannot be shared — the recipient would
   * land on the mode picker holding a payload nothing renders. That is a *runtime capability*
   * of the build, distinct from the data being unreadable below, and both disable the row.
   */
  const modes = registeredModules().map((definition) => ({
    id: definition.codec.id,
    label: definition.label,
    viewable: definition.viewable === true,
  }));

  const firstViewable = modes.find((mode) => mode.viewable)?.id ?? DEFAULT_MODULE_ID;

  let selectedModuleId: string = firstViewable;
  let copied = false;
  let error = '';
  let result: { url: string; length: number; warning?: string } | null = null;

  // Default to the active mode, without overriding a choice the user already made.
  let defaulted = false;
  $: if (visible && !defaulted) {
    const active = modes.find((mode) => mode.id === $activeModule?.id && mode.viewable)?.id;
    selectedModuleId = active ?? firstViewable;
    defaulted = true;
  }
  $: if (!visible) {
    defaulted = false;
    copied = false;
    error = '';
    result = null;
  }

  $: quarantined = new Set(Object.keys($saveInput.carried.quarantined));

  $: if (visible) {
    try {
      result = generateShareUrl($saveInput, selectedModuleId);
      error = '';
    } catch (err) {
      result = null;
      error = err instanceof Error ? err.message : 'This design cannot be shared.';
    }
  }

  async function copy(): Promise<void> {
    if (!result) return;
    await navigator.clipboard.writeText(result.url);
    copied = true;
    setTimeout(() => {
      copied = false;
    }, 2000);
  }

  function close(): void {
    dispatch('close');
  }

  function handleBackdropKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') close();
  }
</script>

{#if visible}
  <div
    class="backdrop"
    role="dialog"
    aria-modal="true"
    aria-label="Share design"
    tabindex="-1"
    on:click|self={close}
    on:keydown={handleBackdropKeydown}
  >
    <div class="dialog">
      <div class="dialog-header">
        <h3>Share a link</h3>
        <button class="close-button" on:click={close} aria-label="Close">&times;</button>
      </div>

      <p class="explainer">
        A link carries one mode. The mode you pick travels with the room; the others stay behind.
      </p>

      <div class="modes">
        {#each modes as mode (mode.id)}
          <label class="mode-row" class:disabled={quarantined.has(mode.id) || !mode.viewable}>
            <input
              type="radio"
              name="share-module"
              value={mode.id}
              bind:group={selectedModuleId}
              disabled={quarantined.has(mode.id) || !mode.viewable}
            />
            <span class="mode-label">{mode.label}</span>
            {#if quarantined.has(mode.id)}
              <span class="mode-note">unreadable in this build — cannot be shared</span>
            {:else if !mode.viewable}
              <span class="mode-note">no viewer for this mode yet</span>
            {/if}
          </label>
        {/each}
      </div>

      {#if error}
        <div class="error">{error}</div>
      {:else if result}
        <div class="url-row">
          <input class="url-input" type="text" readonly value={result.url} />
          <button class="copy-button" class:copied on:click={copy}>
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
        <div class="meta">
          <span>{result.length} characters</span>
          {#if result.warning}
            <span class="warning">{result.warning}</span>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .dialog {
    width: min(560px, 92vw);
    background: var(--panel-bg);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    padding: 20px;
  }

  .dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }

  h3 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .close-button {
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 22px;
    line-height: 1;
    cursor: pointer;
  }

  .explainer {
    margin: 0 0 16px;
    font-size: 12px;
    color: var(--text-muted);
  }

  .modes {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 16px;
  }

  .mode-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--text-secondary);
    cursor: pointer;
  }

  .mode-row.disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .mode-label {
    font-weight: 500;
    color: var(--text-primary);
  }

  .mode-note {
    font-size: 11px;
    color: var(--status-error);
  }

  .url-row {
    display: flex;
    gap: 8px;
  }

  .url-input {
    flex: 1;
    min-width: 0;
    padding: 8px;
    font-family: monospace;
    font-size: 12px;
    background: var(--input-bg);
    color: var(--text-secondary);
    border: 1px solid var(--input-border);
    border-radius: var(--radius-sm);
  }

  .copy-button {
    padding: 8px 16px;
    background: var(--button-active);
    border: none;
    border-radius: var(--radius-sm);
    color: white;
    font-size: 13px;
    cursor: pointer;
  }

  .copy-button.copied {
    background: var(--status-success);
  }

  .meta {
    display: flex;
    gap: 12px;
    margin-top: 8px;
    font-size: 11px;
    color: var(--text-muted);
  }

  .warning {
    color: var(--status-warning, #f59e0b);
  }

  .error {
    padding: 10px;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.25);
    border-radius: var(--radius-sm);
    font-size: 12px;
    color: var(--text-secondary);
  }
</style>
