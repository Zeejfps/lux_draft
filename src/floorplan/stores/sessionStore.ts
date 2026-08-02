import { writable, type Readable } from 'svelte/store';
import type { EditorDocument } from '../types/document';
import type { EditorCommand } from '../types/command';
import type { Interaction } from '../types/interaction';
import type { Selection } from '../types/selection';
import type {
  CarriedState,
  Diagnostics,
  History,
  LoadedDocument,
  ModuleRuntimeStatus,
  SaveInput,
  Session,
} from '../types/session';
import { createEmptySession } from '../types/session';
import { previewDocument, assertCommandIsSerializable } from '../commands';
import { reduceSession, type SessionAction } from './reduceSession';

// ============================================
// The store
// ============================================
//
// One `Session` value, one reducer, one emission per action (invariants 1 and 4).
//
// Nothing subscribes to `sessionStore` directly except the narrow derived stores below.
// Components subscribe to those.

function createSessionStore() {
  let current = createEmptySession();
  const { subscribe, set } = writable<Session>(current);

  /**
   * Ran synchronously before `document.open` swaps the session.
   *
   * The module activation registry uses it to tear the active module down *before* the
   * document changes, so no scene layer, handler or projection ever sees two unrelated
   * documents. Core exposes the hook rather than importing the registry, because the registry
   * subscribes to this store.
   */
  const beforeOpenHooks = new Set<() => void>();

  /**
   * Run one action. Returns whether the session changed.
   *
   * `reduceSession` returns the *same reference* for a no-op, and the write is skipped
   * entirely on that — Svelte's `writable` emits on every `set` of an object value even when
   * the reference is unchanged, so returning the old value is not by itself enough to keep a
   * no-op from waking every subscriber.
   */
  function run(action: SessionAction): boolean {
    const next = reduceSession(current, action);
    if (next === current) return false;
    current = next;
    set(next);
    return true;
  }

  return {
    subscribe,

    /** The only way to edit the document (invariant 2). One command, one history entry. */
    dispatch(command: EditorCommand): void {
      if (import.meta.env.DEV) {
        assertCommandIsSerializable(command);
      }
      run({ type: 'command.dispatch', command });
    },

    /** Replace the whole session. Not a command, not undoable, clears history. */
    open(loaded: LoadedDocument): void {
      for (const hook of [...beforeOpenHooks]) hook();
      run({ type: 'document.open', loaded });
    },

    /** Register a teardown hook that runs synchronously before every `open`. */
    beforeOpen(hook: () => void): () => void {
      beforeOpenHooks.add(hook);
      return () => beforeOpenHooks.delete(hook);
    },

    /** Show a candidate command. Writes nothing to the committed document. */
    setInteraction(interaction: Interaction): void {
      run({ type: 'interaction.set', interaction });
    },

    /** Discard the candidate command. The committed document is untouched. */
    cancelInteraction(): void {
      run({ type: 'interaction.cancel' });
    },

    /**
     * Commit the candidate command and return to idle in one emission.
     * Returns true when something was pending.
     */
    finishInteraction(): boolean {
      if (current.interaction.kind !== 'commandPreview') return false;
      run({ type: 'interaction.commit' });
      return true;
    },

    select(selection: Selection): void {
      run({ type: 'selection.set', selection });
    },

    undo(): boolean {
      return run({ type: 'history.undo' });
    },

    redo(): boolean {
      return run({ type: 'history.redo' });
    },

    setRuntimeStatus(moduleId: string, status: ModuleRuntimeStatus): void {
      run({ type: 'diagnostics.setRuntimeStatus', moduleId, status });
    },

    /** Reading the whole session outside this file is a smell; the narrow stores are below. */
    current(): Session {
      return current;
    },
  };
}

export const sessionStore = createSessionStore();

// ============================================
// Narrow derived stores
// ============================================
//
// One `Session` means every pointer move notifies every subscriber. Each store below emits
// only when *its own slice* changed, guarded by reference equality — so a selection change
// does not invalidate the geometry a renderer rebuilds from.
//
// The guard is per subscriber rather than shared, so a late subscriber still gets the current
// value on subscribe, exactly like any other Svelte store.

function slice<T>(select: (session: Session) => T): Readable<T> {
  return {
    /**
     * The `invalidate` callback is deliberately **not** forwarded to the session store.
     *
     * Svelte's `derived` marks a dependency pending on `invalidate` and clears it on the
     * matching `run`, refusing to recompute while anything is pending. Forwarding it would
     * set that bit on every session change and clear it only on the ones this slice actually
     * emits — so the first suppressed emission would wedge every `derived` built on top of
     * this store permanently. Not forwarding it means the bit is never set, and `derived`
     * recomputes exactly when this slice emits.
     */
    subscribe(run) {
      let last: T;
      let started = false;
      return sessionStore.subscribe((session) => {
        const next = select(session);
        if (started && next === last) return;
        started = true;
        last = next;
        run(next);
      });
    },
  };
}

// `previewDocument` allocates when a command is pending, so it is memoized on the session
// reference: without this, `roomStore` would emit a fresh document object for every session
// change of any kind, and the reference guard above would never fire.
let previewedFrom: Session | null = null;
let previewed: EditorDocument | null = null;

function livePreview(session: Session): EditorDocument {
  if (previewedFrom !== session || previewed === null) {
    previewedFrom = session;
    previewed = previewDocument(session.document, session.interaction);
  }
  return previewed;
}

/**
 * Live view: the committed document with the candidate command applied. What the editor
 * renders — during a gesture it shows the preview, exactly as writing mid-drag used to.
 *
 * Derived visuals must read this or they freeze mid-drag; persistence must read
 * `committedDocument` or it saves half a gesture.
 */
export const roomStore: Readable<EditorDocument> = slice(livePreview);

/** What history, autosave, export and share read. Never includes a preview. */
export const committedDocument: Readable<EditorDocument> = slice((s) => s.document);

/** Ephemeral gesture state. Read-only: write it through `sessionStore.setInteraction`. */
export const interaction: Readable<Interaction> = slice((s) => s.interaction);

/** Read-only. Phase 2 migrates the six `appStore` selection stores onto this. */
export const selection: Readable<Selection> = slice((s) => s.selection);

export const history: Readable<History> = slice((s) => s.history);

export const diagnostics: Readable<Diagnostics> = slice((s) => s.diagnostics);

export const carried: Readable<CarriedState> = slice((s) => s.carried);

// `saveInput` allocates its pair, so it is memoized on its two parts: autosave, export and
// share all subscribe to it and must not see a new object on every selection change.
let savedFrom: { document: EditorDocument; carried: CarriedState } | null = null;
let saved: SaveInput | null = null;

function saveInputOf(session: Session): SaveInput {
  if (
    saved === null ||
    savedFrom === null ||
    savedFrom.document !== session.document ||
    savedFrom.carried !== session.carried
  ) {
    savedFrom = { document: session.document, carried: session.carried };
    saved = { document: session.document, carried: session.carried };
  }
  return saved;
}

/**
 * What autosave, export and share read: the **committed** document paired with the carried
 * quarantine state `encodeDocument` requires. Never includes a preview.
 */
export const saveInput: Readable<SaveInput> = slice(saveInputOf);
