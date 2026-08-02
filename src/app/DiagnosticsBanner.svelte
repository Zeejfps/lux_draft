<script lang="ts">
  import { diagnostics } from '../floorplan/stores/sessionStore';

  /**
   * The one place the user finds out that part of their document could not be read, or that a
   * mode failed to load.
   *
   * `Diagnostics.warnings` has been populated on every real load since phase 3b and had no UI
   * at all: a share link whose lighting blob was written by a newer build quarantined silently
   * and looked like an empty design. Geometry still loads and stays editable (invariant 8), and
   * the blob is written back verbatim on save — which is exactly what the user needs told.
   *
   * Session-scoped and dismissible. Reopening a document repopulates it.
   */
  let dismissed = false;

  $: warnings = $diagnostics.warnings;
  $: failedRuntimes = Object.entries($diagnostics.runtimeStatus)
    .filter(([, status]) => status.kind === 'failed')
    .map(([moduleId, status]) => ({
      moduleId,
      message: status.kind === 'failed' ? status.message : '',
    }));
  $: total = warnings.length + failedRuntimes.length;

  // A new load is a new set of problems, so the banner comes back.
  $: if (total > 0 && warnings) dismissed = false;
</script>

{#if total > 0 && !dismissed}
  <div class="diagnostics" role="status">
    <div class="body">
      <strong>This design opened with problems.</strong>
      <ul>
        {#each warnings as warning (warning.moduleId ?? warning.message)}
          <li>{warning.message}</li>
        {/each}
        {#each failedRuntimes as failure (failure.moduleId)}
          <li>
            The {failure.moduleId} mode could not load ({failure.message}). Its data is intact and
            will be saved unchanged.
          </li>
        {/each}
      </ul>
      <p class="hint">
        Everything that could be read is editable, and anything that could not is preserved exactly
        as it was when you save.
      </p>
    </div>
    <button class="dismiss" on:click={() => (dismissed = true)} title="Dismiss">×</button>
  </div>
{/if}

<style>
  .diagnostics {
    position: absolute;
    top: var(--spacing-16);
    right: var(--spacing-16);
    z-index: 50;
    max-width: 380px;
    display: flex;
    gap: var(--spacing-8);
    align-items: flex-start;
    padding: var(--spacing-12) var(--spacing-16);
    background: var(--panel-bg);
    border: 1px solid rgba(251, 191, 36, 0.5);
    border-left: 3px solid var(--status-warning, #fbbf24);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-md);
    font-size: 13px;
    color: var(--text-secondary);
  }

  .body {
    flex: 1;
  }

  strong {
    color: var(--text-primary);
  }

  ul {
    margin: var(--spacing-8) 0 0 0;
    padding-left: 18px;
  }

  li {
    margin-bottom: 4px;
  }

  .hint {
    margin: var(--spacing-8) 0 0 0;
    font-size: 11px;
    color: var(--text-muted);
  }

  .dismiss {
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
    padding: 0 2px;
  }

  .dismiss:hover {
    color: var(--text-primary);
  }
</style>
