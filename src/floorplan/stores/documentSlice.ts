import type { Readable } from 'svelte/store';
import type { EditorDocument } from '../types/document';

/**
 * A narrow, guarded view of the document.
 *
 * One `Session` means every pointer move notifies every subscriber, so each projection emits
 * only when *its own* value changed. `readModule` and plain field reads return the stored
 * value by reference, so the default reference guard is enough; a selector that merges
 * defaults (and therefore allocates) passes `valueEqual`.
 *
 * Hand-written rather than a Svelte `derived`: `derived` calls `set` on every dependency
 * emission and `writable.set` always notifies for object values, so it cannot suppress
 * anything.
 */
export function documentSlice<T>(
  source: Readable<EditorDocument>,
  select: (doc: EditorDocument) => T,
  equals: (a: T, b: T) => boolean = Object.is
): Readable<T> {
  return {
    subscribe(run, invalidate) {
      let last: T;
      let started = false;
      return source.subscribe((doc) => {
        const next = select(doc);
        if (started && equals(next, last)) return;
        started = true;
        last = next;
        run(next);
      }, invalidate);
    },
  };
}
