import type { EditorCommand } from '../types/command';
import type { Interaction } from '../types/interaction';
import type { Selection } from '../types/selection';
import type {
  History,
  HistoryEntry,
  LoadedDocument,
  ModuleRuntimeStatus,
  Session,
} from '../types/session';
import { IDLE_INTERACTION } from '../types/interaction';
import { NO_SELECTION } from '../types/selection';
import { EMPTY_HISTORY } from '../types/session';
import { applyCommand, commandLabel, valueEqual } from '../commands';
import { deepFreeze } from '../utils/deepFreeze';

/**
 * Every session transition is one reducer action (invariant 4). Rules that used to be
 * call-site discipline — clear the interaction before restoring a snapshot, do not record a
 * history entry for a load, do not record one for a no-op — are cases in one switch.
 */
export type SessionAction =
  | { type: 'document.open'; loaded: LoadedDocument }
  | { type: 'command.dispatch'; command: EditorCommand }
  | { type: 'interaction.set'; interaction: Interaction }
  | { type: 'interaction.commit' }
  | { type: 'interaction.cancel' }
  | { type: 'selection.set'; selection: Selection }
  | { type: 'history.undo' }
  | { type: 'history.redo' }
  | { type: 'diagnostics.setRuntimeStatus'; moduleId: string; status: ModuleRuntimeStatus };

/** Preserved from the pre-reducer history store. */
export const MAX_HISTORY = 50;

/**
 * Push one labeled entry, evicting oldest-first from `past` only.
 *
 * Undo and redo move entries between the stacks rather than evicting, so the invariant is
 * `past.length + future.length <= MAX_HISTORY`.
 */
function pushHistory(history: History, entry: HistoryEntry): History {
  const past = [...history.past, entry];
  if (past.length > MAX_HISTORY) past.shift();
  return { past, future: [] };
}

/**
 * Apply a command to the committed document, recording one history entry.
 *
 * A value-equal result is not an edit: the session is returned **by reference**, which is what
 * lets the store skip its write entirely and emit nothing (Svelte's `writable` emits on every
 * `set` of an object, reference-equal or not, so returning the same value is necessary but the
 * store still has to decline to write it).
 */
function commit(session: Session, command: EditorCommand, interaction: Interaction): Session {
  const next = applyCommand(session.document, command);
  if (valueEqual(next, session.document)) {
    return interaction === session.interaction ? session : { ...session, interaction };
  }
  if (import.meta.env.DEV) {
    deepFreeze(next);
  }
  return {
    ...session,
    document: next,
    interaction,
    history: pushHistory(session.history, {
      document: session.document,
      label: commandLabel(command),
    }),
  };
}

/** Pure, total, exhaustively switched. The whole state machine. */
export function reduceSession(session: Session, action: SessionAction): Session {
  switch (action.type) {
    case 'document.open': {
      // Replace document, carried, diagnostics, history, selection and interaction at once.
      // A load is not an edit, so it pushes no undo entry and discards the ones it replaces.
      const { loaded } = action;
      if (import.meta.env.DEV) {
        deepFreeze(loaded.document);
      }
      return {
        document: loaded.document,
        carried: loaded.carried,
        diagnostics: loaded.diagnostics,
        selection: NO_SELECTION,
        interaction: IDLE_INTERACTION,
        history: EMPTY_HISTORY,
      };
    }

    case 'command.dispatch':
      return commit(session, action.command, session.interaction);

    case 'interaction.commit': {
      // One value: dispatch the previewed command, push history, and return to idle. The
      // preview and the commit apply the identical command to the identical base, so the last
      // frame the user saw is by construction what gets committed (invariant 3).
      if (session.interaction.kind !== 'commandPreview') return session;
      return commit(session, session.interaction.command, IDLE_INTERACTION);
    }

    case 'interaction.set': {
      if (valueEqual(session.interaction, action.interaction)) return session;
      return { ...session, interaction: action.interaction };
    }

    case 'interaction.cancel': {
      if (session.interaction.kind === 'idle') return session;
      return { ...session, interaction: IDLE_INTERACTION };
    }

    case 'selection.set': {
      if (valueEqual(session.selection, action.selection)) return session;
      return { ...session, selection: action.selection };
    }

    case 'history.undo': {
      const { past, future } = session.history;
      const entry = past.at(-1);
      if (!entry) return session;
      // Undo and redo *clear* the interaction rather than coexisting with it: a surviving
      // candidate command would be re-applied to the restored document using ids and vertex
      // indices resolved against the pre-undo one.
      return {
        ...session,
        document: entry.document,
        interaction: IDLE_INTERACTION,
        history: {
          past: past.slice(0, -1),
          future: [{ document: session.document, label: entry.label }, ...future],
        },
      };
    }

    case 'history.redo': {
      const { past, future } = session.history;
      const entry = future[0];
      if (!entry) return session;
      return {
        ...session,
        document: entry.document,
        interaction: IDLE_INTERACTION,
        history: {
          past: [...past, { document: session.document, label: entry.label }],
          future: future.slice(1),
        },
      };
    }

    case 'diagnostics.setRuntimeStatus': {
      const { moduleId, status } = action;
      if (valueEqual(session.diagnostics.runtimeStatus[moduleId], status)) return session;
      return {
        ...session,
        diagnostics: {
          ...session.diagnostics,
          runtimeStatus: { ...session.diagnostics.runtimeStatus, [moduleId]: status },
        },
      };
    }
  }
}
