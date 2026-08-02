import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { get, writable } from 'svelte/store';
import type { ModuleCodec } from '../../../src/floorplan/types/module';
import type { ModuleRuntime, SceneLayer } from '../../../src/floorplan/types/moduleRuntime';
import { clearModuleRegistry, registerModule } from '../../../src/floorplan/types/moduleRegistry';
import {
  activeModule,
  deactivateModule,
  runtimeState,
  setModuleScene,
} from '../../../src/floorplan/stores/moduleActivation';
import { sessionStore } from '../../../src/floorplan/stores/sessionStore';
import { asLoadedDocument } from '../../../src/floorplan/types/session';
import { createEmptyDocument } from '../../../src/floorplan/types/document';
import { installModules } from '../../../src/modules/codecs';
import { applyRoute, startModuleRouting } from '../../../src/app/moduleRouting';

/**
 * Phase 5's acceptance criteria: rapid `#/lighting` → `#/flooring` → `#/lighting` navigation,
 * and a document open landing mid-activation, each end with **exactly one** active module and
 * no leaks.
 *
 * Flooring does not exist yet (phase 6), so both modules here are stubs with controllable
 * load timing — which is the point: the activation machine has to be proven before a second
 * real module lands, not after.
 */

interface Deferred {
  promise: Promise<ModuleRuntime>;
  resolve: (runtime: ModuleRuntime) => void;
}

function deferred(): Deferred {
  let resolve!: (runtime: ModuleRuntime) => void;
  const promise = new Promise<ModuleRuntime>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const stubCodec = (id: string): ModuleCodec<{ n: number }> => ({
  id,
  schemaVersion: 1,
  defaultData: () => ({ n: 0 }),
  decode: () => ({ status: 'ok', data: { n: 0 } }),
});

let scene: THREE.Scene;
let subscribers: number;
let store: ReturnType<typeof writable<number>>;

/** A layer owning one named scene child, so an orphan from a losing activation is countable. */
function countingLayer(target: THREE.Scene, id: string): SceneLayer {
  const object = new THREE.Object3D();
  object.name = id;
  target.add(object);
  return {
    id,
    update: () => {},
    setVisible: () => {},
    dispose: () => {
      target.remove(object);
    },
  };
}

function stubRuntime(id: string): ModuleRuntime {
  return {
    id,
    label: id,
    layers: (s) => [countingLayer(s as THREE.Scene, `${id}.layer`)],
    onActivate: (_ctx, scope) => {
      const stop = store.subscribe(() => {});
      subscribers += 1;
      scope.own(() => {
        subscribers -= 1;
        stop();
      });
    },
  };
}

/** Exactly one module active, and every other module's contributions gone. */
function expectExactlyOneActive(id: string): void {
  expect(get(activeModule)?.id).toBe(id);
  expect(runtimeState().status).toBe('active');
  expect(scene.children.map((c) => c.name)).toEqual([`${id}.layer`]);
  expect(subscribers).toBe(1);
}

beforeEach(() => {
  clearModuleRegistry();
  scene = new THREE.Scene();
  subscribers = 0;
  store = writable(0);
  setModuleScene(scene);
  sessionStore.open(asLoadedDocument(createEmptyDocument()));
});

afterEach(() => {
  deactivateModule();
  setModuleScene(null);
  window.location.hash = '';
  clearModuleRegistry();
  installModules();
});

function registerStub(id: string, loadRuntime: () => Promise<ModuleRuntime>): void {
  registerModule({ codec: stubCodec(id), commands: [], label: id, loadRuntime });
}

describe('rapid navigation', () => {
  it('lighting → flooring → lighting with every load in flight ends with one active module', async () => {
    const lighting = [deferred(), deferred()];
    const flooring = deferred();
    let lightingLoads = 0;

    registerStub('lighting', () => lighting[lightingLoads++].promise);
    registerStub('flooring', () => flooring.promise);

    // Three route changes, none of them awaited — a user out-running an import().
    const first = applyRoute({ kind: 'editor', moduleId: 'lighting' });
    const second = applyRoute({ kind: 'editor', moduleId: 'flooring' });
    const third = applyRoute({ kind: 'editor', moduleId: 'lighting' });

    // Resolve them out of order, losers last.
    lighting[1].resolve(stubRuntime('lighting'));
    await third;
    flooring.resolve(stubRuntime('flooring'));
    await second;
    lighting[0].resolve(stubRuntime('lighting'));
    await first;

    expectExactlyOneActive('lighting');
  });

  it('the two stale activations construct nothing, so there is nothing to dispose', async () => {
    const flooring = deferred();
    registerStub('lighting', () => Promise.resolve(stubRuntime('lighting')));
    registerStub('flooring', () => flooring.promise);

    await applyRoute({ kind: 'editor', moduleId: 'lighting' });
    expectExactlyOneActive('lighting');

    const pending = applyRoute({ kind: 'editor', moduleId: 'flooring' });
    // Torn down synchronously the moment the route changed: no layer straddles two modes.
    expect(get(activeModule)).toBeNull();
    expect(scene.children).toHaveLength(0);
    expect(subscribers).toBe(0);

    await applyRoute({ kind: 'editor', moduleId: 'lighting' });
    flooring.resolve(stubRuntime('flooring'));
    await pending;

    expectExactlyOneActive('lighting');
  });

  it('the picker and the viewer routes leave nothing active', async () => {
    registerStub('lighting', () => Promise.resolve(stubRuntime('lighting')));
    await applyRoute({ kind: 'editor', moduleId: 'lighting' });

    await applyRoute({ kind: 'picker' });
    expect(get(activeModule)).toBeNull();
    expect(scene.children).toHaveLength(0);
    expect(subscribers).toBe(0);

    await applyRoute({ kind: 'editor', moduleId: 'lighting' });
    await applyRoute({ kind: 'viewer', moduleId: 'lighting' });
    expect(get(activeModule)).toBeNull();
    expect(subscribers).toBe(0);
  });
});

describe('startModuleRouting', () => {
  it('activates from the hash and follows every change', async () => {
    registerStub('lighting', () => Promise.resolve(stubRuntime('lighting')));
    registerStub('flooring', () => Promise.resolve(stubRuntime('flooring')));

    window.location.hash = '/lighting';
    const stop = startModuleRouting();
    await Promise.resolve();
    expectExactlyOneActive('lighting');

    window.location.hash = '/flooring';
    window.dispatchEvent(new Event('hashchange'));
    await Promise.resolve();
    expectExactlyOneActive('flooring');

    stop();
  });
});

describe('a document open landing mid-activation', () => {
  it('ends with exactly one active module and no leaks', async () => {
    const loads = [deferred(), deferred()];
    let index = 0;
    registerStub('lighting', () => loads[index++].promise);

    const pending = applyRoute({ kind: 'editor', moduleId: 'lighting' });
    expect(runtimeState().status).toBe('loading');

    // The share link opens while the runtime is still in flight. `beforeOpen` deactivates and
    // schedules a re-activation, which starts a *second* load.
    sessionStore.open(asLoadedDocument(createEmptyDocument()));
    expect(get(activeModule)).toBeNull();

    loads[1].resolve(stubRuntime('lighting'));
    await loads[1].promise;
    await Promise.resolve();

    // The first load resolves last, against a stale token: it builds nothing.
    loads[0].resolve(stubRuntime('lighting'));
    await pending;
    await Promise.resolve();

    expectExactlyOneActive('lighting');
  });

  it('an open after activation rebuilds the scope exactly once', async () => {
    registerStub('lighting', () => Promise.resolve(stubRuntime('lighting')));
    await applyRoute({ kind: 'editor', moduleId: 'lighting' });

    sessionStore.open(asLoadedDocument(createEmptyDocument()));
    await Promise.resolve();
    await Promise.resolve();

    expectExactlyOneActive('lighting');
  });
});
