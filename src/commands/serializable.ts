import type { EditorCommand } from '../types/command';

/**
 * Structural value equality for plain JSON-ish data.
 *
 * Keys whose value is `undefined` are treated as absent, so a value that has been through
 * `JSON.parse(JSON.stringify(...))` compares equal to the value it came from.
 */
export function valueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!valueEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const key of keys) {
    if (!valueEqual(ao[key], bo[key])) return false;
  }
  return true;
}

/**
 * Dev-only guard: a command must be serializable data, so it can be logged, replayed, and
 * round-tripped through storage. Without this, `EditorCommand` quietly degrades into a
 * tagged callback the first time someone stuffs a Map, a Set, or a class instance into one.
 */
export function assertCommandIsSerializable(command: EditorCommand): void {
  let json: string;
  try {
    json = JSON.stringify(command);
  } catch (e) {
    throw new Error(
      `Command "${command.type}" is not serializable: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  if (json === undefined) {
    throw new Error(
      `Command "${command.type}" is not serializable: JSON.stringify returned undefined`
    );
  }
  if (!valueEqual(JSON.parse(json), command)) {
    throw new Error(
      `Command "${command.type}" does not survive a JSON round-trip value-identically. ` +
        'Commands must be plain data — no Map, Set, class instance, function, or NaN/Infinity.'
    );
  }
}
