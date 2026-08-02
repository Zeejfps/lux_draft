import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as THREE from 'three';
import { get, writable } from 'svelte/store';
import type { ModuleCodec } from '../../../src/floorplan/types/module';
import type {
  ActivationScope,
  ModuleRuntime,
  SceneLayer,
} from '../../../src/floorplan/types/moduleRuntime';
import { clearModuleRegistry, registerModule } from '../../../src/floorplan/types/moduleRegistry';
import {
  activateModule,
  activeModule,
  deactivateModule,
  runtimeState,
  setModuleScene,
} from '../../../src/floorplan/stores/moduleActivation';
import { sessionStore } from '../../../src/floorplan/stores/sessionStore';
import { asLoadedDocument, type LoadedDocument } from '../../../src/floorplan/types/session';
import { createEmptyDocument } from '../../../src/floorplan/types/document';
import { encodeDocument } from '../../../src/floorplan/persistence/documentCodec';
import { withModule } from '../../../src/floorplan/types/module';
import { installModules } from '../../../src/modules/codecs';

/**
 * Activation is an owned scope.
 *
 * The three acceptance criteria of phase 4 live here: activate → deactivate → activate leaves
 * nothing behind, a mode switch mid-load discards the stale resolution, and a rejected
 * `loadRuntime` disables the mode while the module's data still round-trips through save.
 */

interface Deferred {
  promise: Promise<ModuleRuntime>;
  resolve: (runtime: ModuleRuntime) => void;
  reject: (error: Error) => void;
}

function deferred(): Deferred {
  let resolve!: (runtime: ModuleRuntime) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ModuleRuntime>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const stubCodec = (id: string): ModuleCodec<{ n: number }> => ({
  id,
  schemaVersion: 1,
  defaultData: () => ({ n: 0 }),
  decode: (blob) => {
    const data = blob.data as { n?: unknown };
    return typeof data?.n === 'number'
      ? { status: 'ok', data: { n: data.n } }
      : { status: 'invalid', message: 'not a stub slice' };
  },
});

/** A layer that owns one scene child, so an orphan is countable. */
function countingLayer(scene: THREE.Scene, id: string): SceneLayer {
  const object = new THREE.Object3D();
  object.name = id;
  scene.add(object);
  return {
    id,
    update: () => {},
    setVisible: () => {},
    dispose: () => {
      scene.remove(object);
    },
  };
}

let scene: THREE.Scene;
let subscribers: number;
let store: ReturnType<typeof writable<number>>;
let scopes: ActivationScope[];

function stubRuntime(id: string, layerIds: string[]): ModuleRuntime {
  return {
    id,
    label: id,
    layers: (s) => layerIds.map((layerId) => countingLayer(s as THREE.Scene, layerId)),
    handlers: () => [],
    onActivate: (_ctx, scope) => {
      scopes.push(scope);
      // A derived subscription — the kind that leaks if only layers and handlers are owned.
      const stop = store.subscribe(() => {});
      subscribers += 1;
      scope.own(() => {
        subscribers -= 1;
        stop();
      });
    },
  };
}

beforeEach(() => {
  clearModuleRegistry();
  scene = new THREE.Scene();
  subscribers = 0;
  scopes = [];
  store = writable(0);
  setModuleScene(scene);
  sessionStore.open(asLoadedDocument(createEmptyDocument()));
});

afterEach(() => {
  deactivateModule();
  setModuleScene(null);
  clearModuleRegistry();
  installModules();
});

describe('activate → deactivate → activate', () => {
  it('leaves zero orphaned scene children and zero live subscriptions', async () => {
    const runtime = stubRuntime('alpha', ['alpha.one', 'alpha.two']);
    registerModule({
      codec: stubCodec('alpha'),
      commands: [],
      label: 'Alpha',
      loadRuntime: () => Promise.resolve(runtime),
    });

    await activateModule('alpha');
    expect(scene.children).toHaveLength(2);
    expect(subscribers).toBe(1);
    expect(get(activeModule)?.id).toBe('alpha');

    deactivateModule();
    expect(scene.children).toHaveLength(0);
    expect(subscribers).toBe(0);
    expect(get(activeModule)).toBeNull();

    await activateModule('alpha');
    expect(scene.children).toHaveLength(2);
    expect(subscribers).toBe(1);

    // The record is cached; the scope is not — a fresh one per activation.
    expect(scopes).toHaveLength(2);
    expect(scopes[0]).not.toBe(scopes[1]);
  });

  it('disposing a scope aborts its signal', async () => {
    registerModule({
      codec: stubCodec('alpha'),
      commands: [],
      label: 'Alpha',
      loadRuntime: () => Promise.resolve(stubRuntime('alpha', ['alpha.one'])),
    });

    await activateModule('alpha');
    const signal = scopes[0].signal;
    expect(signal.aborted).toBe(false);

    deactivateModule();
    expect(signal.aborted).toBe(true);
  });

  it('ownership after disposal runs the disposer immediately rather than retaining it', async () => {
    registerModule({
      codec: stubCodec('alpha'),
      commands: [],
      label: 'Alpha',
      loadRuntime: () => Promise.resolve(stubRuntime('alpha', ['alpha.one'])),
    });
    await activateModule('alpha');
    const scope = scopes[0];
    deactivateModule();

    const late = vi.fn();
    scope.own(late);
    expect(late).toHaveBeenCalledTimes(1);
  });
});

describe('loading races', () => {
  it('dedups a second activate() while loading', async () => {
    const load = vi.fn(() => Promise.resolve(stubRuntime('alpha', ['alpha.one'])));
    registerModule({ codec: stubCodec('alpha'), commands: [], label: 'Alpha', loadRuntime: load });

    const first = activateModule('alpha');
    const second = activateModule('alpha');
    expect(second).toBe(first);
    await first;

    expect(load).toHaveBeenCalledTimes(1);
    expect(scene.children).toHaveLength(1);
    expect(scopes).toHaveLength(1);
  });

  it('a mode switch mid-load discards the stale resolution', async () => {
    const slow = deferred();
    registerModule({
      codec: stubCodec('alpha'),
      commands: [],
      label: 'Alpha',
      loadRuntime: () => slow.promise,
    });
    registerModule({
      codec: stubCodec('beta'),
      commands: [],
      label: 'Beta',
      loadRuntime: () => Promise.resolve(stubRuntime('beta', ['beta.one'])),
    });

    const pending = activateModule('alpha');
    expect(runtimeState().status).toBe('loading');

    // Switch before alpha resolves.
    await activateModule('beta');
    expect(get(activeModule)?.id).toBe('beta');
    expect(scene.children.map((c) => c.name)).toEqual(['beta.one']);

    // Alpha resolves against a stale token: it constructs nothing, so there is nothing to
    // dispose and beta is untouched.
    slow.resolve(stubRuntime('alpha', ['alpha.one']));
    await pending;

    expect(get(activeModule)?.id).toBe('beta');
    expect(scene.children.map((c) => c.name)).toEqual(['beta.one']);
    expect(subscribers).toBe(1);
    expect(scopes).toHaveLength(1);
  });

  it('opening a document deactivates before the swap and re-activates after', async () => {
    registerModule({
      codec: stubCodec('alpha'),
      commands: [],
      label: 'Alpha',
      loadRuntime: () => Promise.resolve(stubRuntime('alpha', ['alpha.one'])),
    });
    await activateModule('alpha');
    const firstScope = scopes[0];

    sessionStore.open(asLoadedDocument(createEmptyDocument()));
    // Synchronously torn down: no layer ever sees two unrelated documents.
    expect(firstScope.signal.aborted).toBe(true);
    expect(get(activeModule)).toBeNull();
    expect(scene.children).toHaveLength(0);

    await Promise.resolve();
    await Promise.resolve();
    expect(get(activeModule)?.id).toBe('alpha');
    expect(scene.children).toHaveLength(1);
    expect(subscribers).toBe(1);
  });
});

describe('a rejected loadRuntime', () => {
  it('disables the mode and still round-trips the module data through save', async () => {
    const codec = stubCodec('alpha');
    registerModule({
      codec,
      commands: [],
      label: 'Alpha',
      loadRuntime: () => Promise.reject(new Error('chunk 404')),
    });

    const failing = vi.spyOn(console, 'error').mockImplementation(() => {});

    const document = withModule(createEmptyDocument(), codec, () => ({ n: 7 }));
    const loaded: LoadedDocument = asLoadedDocument(document);
    sessionStore.open(loaded);

    await activateModule('alpha');

    // Mode unavailable this session…
    expect(get(activeModule)).toBeNull();
    expect(runtimeState().status).toBe('failed');
    expect(sessionStore.current().diagnostics.runtimeStatus.alpha).toEqual({
      kind: 'failed',
      message: 'chunk 404',
    });
    expect(scene.children).toHaveLength(0);

    // …but the data is live and saves exactly as if the mode had been visited.
    const session = sessionStore.current();
    const envelope = encodeDocument(session.document, session.carried, { kind: 'file' });
    expect(envelope.modules.alpha).toEqual({ v: 1, data: { n: 7 } });

    failing.mockRestore();
  });
});
