import { activateModule, deactivateModule } from '../floorplan/stores/moduleActivation';
import { currentRoute, type Route } from './routerStore';

/**
 * The route → activation glue, extracted from `App.svelte` so it can be driven by a test.
 *
 * Exactly one module is active at a time and the route says which. Everything that makes rapid
 * switching safe already lives in `moduleActivation.ts` (dedup, the generation token, the scope
 * that owns every contribution, and `sessionStore.beforeOpen`); this file only decides *what to
 * ask for*, and it must never await one activation before starting the next — a route change
 * is synchronous and the user is allowed to out-run an `import()`.
 */

/** Settle activation for one route. Never rejects: a failed runtime is a session state. */
export function applyRoute(route: Route): Promise<void> {
  if (route.kind === 'editor') {
    return activateModule(route.moduleId).catch((error: unknown) => {
      console.error('Failed to activate module for route', route, error);
    });
  }
  // The picker has no scene, and the viewer builds its own layers without the registry.
  deactivateModule();
  return Promise.resolve();
}

/** Subscribe activation to the route. Returns the unsubscribe. */
export function startModuleRouting(): () => void {
  return currentRoute.subscribe((route) => {
    void applyRoute(route);
  });
}
