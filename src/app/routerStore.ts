import { writable, type Readable } from 'svelte/store';
import { isModuleViewable, registeredModules } from '../floorplan/types/moduleRegistry';
import { LIGHTING_MODULE_ID } from '../modules/lighting/codec';

/**
 * Studio routing.
 *
 * | Hash                    | Route                              |
 * | ----------------------- | ---------------------------------- |
 * | `#/`                    | editor, lighting (permanent alias) |
 * | `#/viewer`              | viewer, lighting (permanent alias) |
 * | `#/modes`               | the mode picker                    |
 * | `#/{module}`            | editor, that module                |
 * | `#/{module}/viewer`     | viewer, that module                |
 * | anything else           | the mode picker                    |
 *
 * The two bare forms are **permanent** aliases, not transitional ones: share links in the wild
 * encode `#/viewer?d=…` and bookmarks encode `#/`, and neither can be rewritten after the fact.
 * They resolve to lighting because that is what the app was before it had modes.
 *
 * A hash naming a module this build does not have installed resolves to the picker rather than
 * to lighting — silently showing a different mode's document is worse than asking. So does
 * `#/{module}/viewer` for a module with no viewer (`ModuleDefinition.viewable`), for the same
 * reason: the viewer page builds one module's layers by hand, so rendering it for another mode
 * would show the wrong canvas under the right URL.
 *
 * `app/` may import anything, which is why the default module id is named here and nowhere in
 * `floorplan/`.
 */

export type Route =
  | { kind: 'picker' }
  | { kind: 'editor'; moduleId: string }
  | { kind: 'viewer'; moduleId: string };

/** What the bare `#/` and `#/viewer` aliases resolve to. Permanent. */
export const DEFAULT_MODULE_ID = LIGHTING_MODULE_ID;

/** The mode-picker landing route. */
export const PICKER_PATH = 'modes';

const VIEWER_SEGMENT = 'viewer';

export interface RouteState {
  readonly route: Route;
  readonly params: Readonly<Record<string, string>>;
}

function isInstalled(moduleId: string): boolean {
  return registeredModules().some((definition) => definition.codec.id === moduleId);
}

/** Parse query params by hand: `URLSearchParams` turns `+` into a space and breaks lz-string. */
function parseParams(queryPart: string): Record<string, string> {
  const params: Record<string, string> = {};
  if (!queryPart) return params;
  for (const pair of queryPart.split('&')) {
    const eqIndex = pair.indexOf('=');
    if (eqIndex >= 0) {
      params[pair.substring(0, eqIndex)] = pair.substring(eqIndex + 1);
    }
  }
  return params;
}

export function parseRoutePath(path: string): Route {
  const segments = path.split('/').filter((segment) => segment.length > 0);

  if (segments.length === 0) return { kind: 'editor', moduleId: DEFAULT_MODULE_ID };
  if (segments.length === 1 && segments[0] === PICKER_PATH) return { kind: 'picker' };
  // The permanent legacy alias. Every share link generated before phase 5 is this shape.
  if (segments.length === 1 && segments[0] === VIEWER_SEGMENT) {
    return { kind: 'viewer', moduleId: DEFAULT_MODULE_ID };
  }

  const [moduleId, second] = segments;
  if (!isInstalled(moduleId)) return { kind: 'picker' };
  if (segments.length === 1) return { kind: 'editor', moduleId };
  if (segments.length === 2 && second === VIEWER_SEGMENT) {
    // A mode with no viewer resolves to the picker rather than rendering another mode's canvas.
    return isModuleViewable(moduleId) ? { kind: 'viewer', moduleId } : { kind: 'picker' };
  }
  return { kind: 'picker' };
}

export function parseHash(hash: string): RouteState {
  const trimmed = hash.replace(/^#\/?/, '');
  const questionIndex = trimmed.indexOf('?');
  const routePart = questionIndex >= 0 ? trimmed.substring(0, questionIndex) : trimmed;
  const queryPart = questionIndex >= 0 ? trimmed.substring(questionIndex + 1) : '';
  return { route: parseRoutePath(routePart), params: parseParams(queryPart) };
}

/**
 * The canonical hash for a route. Always module-qualified — the bare forms are read, never
 * written, so a link copied out of the address bar names its mode.
 */
export function routePath(route: Route): string {
  switch (route.kind) {
    case 'picker':
      return `/${PICKER_PATH}`;
    case 'editor':
      return `/${route.moduleId}`;
    case 'viewer':
      return `/${route.moduleId}/${VIEWER_SEGMENT}`;
  }
}

const hashState = writable<RouteState>(parseHash(window.location.hash));

window.addEventListener('hashchange', () => {
  hashState.set(parseHash(window.location.hash));
});

export const routeState: Readable<RouteState> = { subscribe: hashState.subscribe };

/**
 * Hand-written guarded slices rather than `derived`: `writable.set` notifies for any object
 * value, so a `derived` here would re-emit the same route on every hash change and re-run the
 * activation glue. See the phase-4 note — a guarded slice must never forward `invalidate`.
 */
function slice<T>(select: (state: RouteState) => T, equal: (a: T, b: T) => boolean): Readable<T> {
  return {
    subscribe(run) {
      let last: T | undefined;
      let started = false;
      return hashState.subscribe((state) => {
        const next = select(state);
        if (started && equal(last as T, next)) return;
        started = true;
        last = next;
        run(next);
      });
    },
  };
}

const sameRoute = (a: Route, b: Route): boolean =>
  a.kind === b.kind && (a.kind === 'picker' ? true : a.moduleId === (b as typeof a).moduleId);

export const currentRoute: Readable<Route> = slice((s) => s.route, sameRoute);

export const routeParams: Readable<Readonly<Record<string, string>>> = slice(
  (s) => s.params,
  (a, b) => {
    const aKeys = Object.keys(a);
    if (aKeys.length !== Object.keys(b).length) return false;
    return aKeys.every((key) => a[key] === b[key]);
  }
);

export function navigate(route: Route, params?: Record<string, string>): void {
  let hash = routePath(route);
  if (params) {
    const queryParts = Object.entries(params).map(([k, v]) => `${k}=${v}`);
    if (queryParts.length > 0) {
      hash += '?' + queryParts.join('&');
    }
  }
  window.location.hash = hash;
}
