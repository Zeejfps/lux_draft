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
/** Throws on anything that is not plain JSON data: Map, Set, class instance, function, NaN. */
export function assertPlainData(value: unknown, path: string): void {
  if (value === null) return;

  const type = typeof value;
  if (type === 'string' || type === 'boolean') return;
  if (type === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new Error(`Command payload at ${path} is ${String(value)}, which JSON cannot express`);
    }
    return;
  }
  if (type === 'undefined') return; // an absent optional field

  if (type !== 'object') {
    throw new Error(`Command payload at ${path} is a ${type}, which is not serializable data`);
  }

  if (Array.isArray(value)) {
    value.forEach((item, i) => assertPlainData(item, `${path}[${i}]`));
    return;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(
      `Command payload at ${path} is a ${(value as object).constructor?.name ?? 'non-plain object'}, ` +
        'which is not serializable data. Commands carry plain objects and arrays only.'
    );
  }

  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    assertPlainData(item, `${path}.${key}`);
  }
}

export function assertCommandIsSerializable(command: EditorCommand): void {
  assertPlainData(command, command.type);

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
