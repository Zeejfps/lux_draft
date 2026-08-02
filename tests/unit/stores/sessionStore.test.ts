/**
 * The store boundary: one action is one emission, a no-op is *no* emission, and each narrow
 * derived store emits only when its own slice changed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { derived, get, type Readable } from 'svelte/store';
import {
  sessionStore,
  roomStore,
  committedDocument,
  interaction,
  selection,
  history,
  diagnostics,
} from '../../../src/floorplan/stores/sessionStore';
import { asLoadedDocument } from '../../../src/floorplan/types/session';
import { squareRoom, makeLight } from '../../helpers/documents';
import { addFixture } from '../../../src/modules/lighting/commands';

/** Counts emissions after the initial one every Svelte store delivers on subscribe. */
function countEmissions<T>(store: Readable<T>, run: () => void): number {
  let count = -1;
  const stop = store.subscribe(() => {
    count++;
  });
  run();
  stop();
  return count;
}

const moveWall = (y: number) =>
  ({ type: 'wall.move', wallId: 'wall-1', start: { x: 0, y }, end: { x: 10, y } }) as const;

describe('sessionStore', () => {
  beforeEach(() => {
    sessionStore.open(asLoadedDocument(squareRoom()));
  });

  describe('one action, one emission', () => {
    it('a dispatch emits once', () => {
      expect(
        countEmissions(committedDocument, () => {
          sessionStore.dispatch({ type: 'space.setCeilingHeight', height: 12 });
        })
      ).toBe(1);
    });

    it('a value-equal dispatch emits nothing at all', () => {
      const height = get(committedDocument).space.ceilingHeight;
      expect(
        countEmissions(sessionStore, () => {
          sessionStore.dispatch({ type: 'space.setCeilingHeight', height });
        })
      ).toBe(0);
    });

    it('committing a drag emits the document and the idle interaction together', () => {
      let interactionAtEmission: string | null = null;
      sessionStore.setInteraction({ kind: 'commandPreview', command: moveWall(-3) });

      const emissions = countEmissions(committedDocument, () => {
        interactionAtEmission = null;
        const stop = committedDocument.subscribe(() => {
          interactionAtEmission = get(interaction).kind;
        });
        expect(sessionStore.finishInteraction()).toBe(true);
        stop();
      });

      expect(emissions).toBe(1);
      // The committed document never appears alongside a stale preview.
      expect(interactionAtEmission).toBe('idle');
    });

    it('undo mid-drag restores the document and clears the interaction in one emission', () => {
      sessionStore.dispatch({ type: 'space.setCeilingHeight', height: 12 });
      sessionStore.setInteraction({ kind: 'commandPreview', command: moveWall(-3) });

      let interactionAtEmission: string | null = null;
      const emissions = countEmissions(committedDocument, () => {
        const stop = committedDocument.subscribe(() => {
          interactionAtEmission = get(interaction).kind;
        });
        expect(sessionStore.undo()).toBe(true);
        stop();
      });

      expect(emissions).toBe(1);
      expect(interactionAtEmission).toBe('idle');
      expect(get(roomStore)).toBe(get(committedDocument));
    });

    it('undo and redo return false when there is nothing to move', () => {
      expect(sessionStore.undo()).toBe(false);
      expect(sessionStore.redo()).toBe(false);
    });
  });

  describe('narrow derived stores', () => {
    it('committedDocument ignores previews; roomStore follows them', () => {
      const committedEmissions = countEmissions(committedDocument, () => {
        const liveEmissions = countEmissions(roomStore, () => {
          sessionStore.setInteraction({ kind: 'commandPreview', command: moveWall(-1) });
          sessionStore.setInteraction({ kind: 'commandPreview', command: moveWall(-2) });
        });
        expect(liveEmissions).toBe(2);
      });
      expect(committedEmissions).toBe(0);
      expect(get(roomStore).geometry.boundary.walls[0].start.y).toBe(-2);
      expect(get(committedDocument).geometry.boundary.walls[0].start.y).toBe(0);
    });

    it('a selection change does not wake the document stores', () => {
      const emissions = countEmissions(roomStore, () => {
        const committed = countEmissions(committedDocument, () => {
          sessionStore.select({ kind: 'wall', id: 'wall-1' });
        });
        expect(committed).toBe(0);
      });
      expect(emissions).toBe(0);
      expect(get(selection)).toEqual({ kind: 'wall', id: 'wall-1' });
    });

    it('a document edit does not wake selection, history labels aside', () => {
      const emissions = countEmissions(selection, () => {
        sessionStore.dispatch(addFixture.make({ fixture: makeLight('l1', { x: 1, y: 1 }) }));
      });
      expect(emissions).toBe(0);
    });

    it('history emits on an edit and not on a preview', () => {
      const onEdit = countEmissions(history, () => {
        sessionStore.dispatch({ type: 'space.setCeilingHeight', height: 9 });
      });
      const onPreview = countEmissions(history, () => {
        sessionStore.setInteraction({ kind: 'commandPreview', command: moveWall(-4) });
        sessionStore.cancelInteraction();
      });
      expect(onEdit).toBe(1);
      expect(onPreview).toBe(0);
    });

    it('diagnostics emits only for its own slice', () => {
      const onEdit = countEmissions(diagnostics, () => {
        sessionStore.dispatch({ type: 'space.setCeilingHeight', height: 11 });
      });
      const onStatus = countEmissions(diagnostics, () => {
        sessionStore.setRuntimeStatus('lighting', { kind: 'active' });
      });
      expect(onEdit).toBe(0);
      expect(onStatus).toBe(1);
    });

    it('roomStore is the committed document itself when idle', () => {
      expect(get(roomStore)).toBe(get(committedDocument));
    });
  });

  describe('open', () => {
    it('clears interaction, selection and history in one action', () => {
      sessionStore.dispatch({ type: 'space.setCeilingHeight', height: 12 });
      sessionStore.select({ kind: 'wall', id: 'wall-1' });
      sessionStore.setInteraction({ kind: 'commandPreview', command: moveWall(-3) });

      sessionStore.open(asLoadedDocument(squareRoom()));

      expect(get(interaction)).toEqual({ kind: 'idle' });
      expect(get(selection)).toEqual({ kind: 'none' });
      expect(get(history).past).toHaveLength(0);
      expect(sessionStore.undo()).toBe(false);
    });
  });
});

describe('a guarded slice underneath a Svelte `derived`', () => {
  beforeEach(() => {
    sessionStore.open(asLoadedDocument(squareRoom()));
  });

  /**
   * The narrow stores suppress emissions, and Svelte's `derived` refuses to recompute while
   * any dependency is *pending* — a bit set by `invalidate` and cleared by the matching `run`.
   * A guarded store that forwards `invalidate` therefore wedges every `derived` above it the
   * first time it suppresses, permanently. Phase 4 surfaced this: the toolbar stopped seeing
   * the active module, because `toolbarTools` is a `derived` over `roomStore`.
   */
  it('keeps recomputing after the slice suppresses an emission', () => {
    let computed = 0;
    const start = derived(roomStore, ($doc) => {
      computed += 1;
      return $doc.geometry.boundary.walls[0].start;
    });
    const stop = start.subscribe(() => {});
    expect(computed).toBe(1);

    // A selection change: the session emits, `roomStore` suppresses (same document). Before
    // the fix this left `derived` pending forever.
    sessionStore.select({ kind: 'wall', id: 'wall-1' });
    sessionStore.select({ kind: 'none' });

    // …and a real geometry change must still get through.
    sessionStore.dispatch(moveWall(3));
    stop();

    expect(computed).toBe(2);
  });

  it('a derived over two guarded slices still tracks both', () => {
    const seen: string[] = [];
    const pair = derived(
      [roomStore, selection],
      ([$doc, $selection]) => `${$doc.geometry.boundary.walls.length}:${$selection.kind}`
    );
    const stop = pair.subscribe((value) => seen.push(value));

    sessionStore.select({ kind: 'wall', id: 'wall-1' });
    sessionStore.dispatch(moveWall(5));
    stop();

    expect(seen).toContain('4:wall');
  });
});
