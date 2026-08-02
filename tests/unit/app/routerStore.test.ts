import { describe, it, expect, afterEach } from 'vitest';
import {
  DEFAULT_MODULE_ID,
  parseHash,
  parseRoutePath,
  routePath,
  type Route,
} from '../../../src/app/routerStore';
import { clearModuleRegistry, registerModule } from '../../../src/floorplan/types/moduleRegistry';
import { installModules } from '../../../src/modules/codecs';
import { generateShareUrl } from '../../../src/floorplan/persistence/shareUrl';
import { createEmptyDocument } from '../../../src/floorplan/types/document';
import type { SaveInput } from '../../../src/floorplan/types/session';
import type { ModuleCodec } from '../../../src/floorplan/types/module';

/**
 * The route table, and the two permanent aliases.
 *
 * `#/` and `#/viewer` are read forever — bookmarks and every share link generated before
 * phase 5 are those shapes — but they are never *written*: `routePath` is always
 * module-qualified.
 */

const emptySave = (): SaveInput => ({
  document: createEmptyDocument(),
  carried: { quarantined: {}, geometryFingerprint: '' },
});

const stubCodec = (id: string): ModuleCodec<Record<string, never>> => ({
  id,
  schemaVersion: 1,
  defaultData: () => ({}),
  decode: () => ({ status: 'ok', data: {} }),
});

afterEach(() => {
  clearModuleRegistry();
  installModules();
});

describe('parseRoutePath', () => {
  const table: [string, Route][] = [
    ['', { kind: 'editor', moduleId: DEFAULT_MODULE_ID }],
    ['/', { kind: 'editor', moduleId: DEFAULT_MODULE_ID }],
    ['viewer', { kind: 'viewer', moduleId: DEFAULT_MODULE_ID }],
    ['modes', { kind: 'picker' }],
    ['lighting', { kind: 'editor', moduleId: 'lighting' }],
    ['lighting/viewer', { kind: 'viewer', moduleId: 'lighting' }],
    ['lighting/viewer/extra', { kind: 'picker' }],
    ['lighting/nonsense', { kind: 'picker' }],
    // Not installed in this build: ask rather than silently show a different mode.
    ['plumbing', { kind: 'picker' }],
    ['plumbing/viewer', { kind: 'picker' }],
    // Installed but editor-only: its viewer route resolves to the picker, not to lighting's
    // canvas under a flooring URL.
    ['flooring', { kind: 'editor', moduleId: 'flooring' }],
    ['flooring/viewer', { kind: 'picker' }],
  ];

  for (const [path, expected] of table) {
    it(`${JSON.stringify(path)} → ${JSON.stringify(expected)}`, () => {
      expect(parseRoutePath(path)).toEqual(expected);
    });
  }

  it('resolves a module once it is installed', () => {
    expect(parseRoutePath('plumbing')).toEqual({ kind: 'picker' });
    registerModule({
      codec: stubCodec('plumbing'),
      commands: [],
      label: 'Plumbing',
      viewable: true,
    });
    expect(parseRoutePath('plumbing')).toEqual({ kind: 'editor', moduleId: 'plumbing' });
    expect(parseRoutePath('plumbing/viewer')).toEqual({ kind: 'viewer', moduleId: 'plumbing' });
  });

  it('an installed module with no viewer routes its viewer path to the picker', () => {
    registerModule({ codec: stubCodec('roofing'), commands: [], label: 'Roofing' });
    expect(parseRoutePath('roofing')).toEqual({ kind: 'editor', moduleId: 'roofing' });
    expect(parseRoutePath('roofing/viewer')).toEqual({ kind: 'picker' });
  });
});

describe('parseHash', () => {
  it('splits the query without touching the payload', () => {
    // `URLSearchParams` turns `+` into a space, which corrupts an lz-string payload.
    const { route, params } = parseHash('#/lighting/viewer?d=A+B%2Fc=');
    expect(route).toEqual({ kind: 'viewer', moduleId: 'lighting' });
    expect(params.d).toBe('A+B%2Fc=');
  });

  it('reads the legacy share shape', () => {
    const { route, params } = parseHash('#/viewer?d=abc');
    expect(route).toEqual({ kind: 'viewer', moduleId: DEFAULT_MODULE_ID });
    expect(params.d).toBe('abc');
  });

  it('carries no params when there is no query', () => {
    expect(parseHash('#/lighting').params).toEqual({});
  });
});

describe('routePath', () => {
  it('always writes the module-qualified form', () => {
    expect(routePath({ kind: 'editor', moduleId: 'lighting' })).toBe('/lighting');
    expect(routePath({ kind: 'viewer', moduleId: 'lighting' })).toBe('/lighting/viewer');
    expect(routePath({ kind: 'picker' })).toBe('/modes');
  });

  it('round-trips every route it writes', () => {
    const routes: Route[] = [
      { kind: 'picker' },
      { kind: 'editor', moduleId: 'lighting' },
      { kind: 'viewer', moduleId: 'lighting' },
    ];
    for (const route of routes) {
      expect(parseRoutePath(routePath(route))).toEqual(route);
    }
  });
});

describe('share links', () => {
  it('emits #/{moduleId}/viewer and parses back to that module', () => {
    const { url } = generateShareUrl(emptySave(), 'lighting');
    expect(url).toContain('#/lighting/viewer?d=');

    const hash = url.substring(url.indexOf('#'));
    const { route, params } = parseHash(hash);
    expect(route).toEqual({ kind: 'viewer', moduleId: 'lighting' });
    expect(params.d.length).toBeGreaterThan(0);
  });

  it('warns about platform truncation well before any browser limit', () => {
    // The old pair was 2000 / 8000, and 8000 is a server request-line limit a URL *fragment*
    // never reaches. The lower band survives because pasted links really do get truncated.
    const short = generateShareUrl(emptySave(), 'lighting');
    expect(short.length).toBeLessThan(2000);
    expect(short.warning).toBeUndefined();
  });
});
