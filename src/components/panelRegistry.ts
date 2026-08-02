import type { ComponentType, SvelteComponent } from 'svelte';
import { selectionPanelKeys, type Selection } from '../types/selection';

/**
 * Panel dispatch: `Selection` → the component that edits it, resolved by `panelKey`.
 *
 * Deliberately ~20 lines and not a module system. Phase 4 changes only *where the map is
 * populated from* — today `App.svelte` registers statically, then it will register from each
 * module runtime's `panels` record. The dispatch seam below does not change.
 */
export type PanelComponent = ComponentType<SvelteComponent<Record<string, never>>>;

export interface ResolvedPanel {
  key: string;
  component: PanelComponent;
}

const panels = new Map<string, PanelComponent>();

/** Throws on a duplicate key: a shadowed panel surfaces later as the wrong panel rendering. */
export function registerPanel(panelKey: string, component: PanelComponent): void {
  if (panels.has(panelKey)) {
    throw new Error(`Duplicate panel key: ${panelKey}`);
  }
  panels.set(panelKey, component);
}

export function registerPanels(entries: Record<string, PanelComponent>): void {
  for (const [panelKey, component] of Object.entries(entries)) {
    registerPanel(panelKey, component);
  }
}

export function resolvePanel(panelKey: string): PanelComponent | null {
  return panels.get(panelKey) ?? null;
}

/** Every registered panel the current selection asks for. A `multi` selection asks for several. */
export function panelsForSelection(selection: Selection): ResolvedPanel[] {
  const resolved: ResolvedPanel[] = [];
  for (const key of selectionPanelKeys(selection)) {
    const component = panels.get(key);
    if (component) resolved.push({ key, component });
  }
  return resolved;
}

/** Test seam. Phase 4 will also need it when runtimes deactivate. */
export function clearPanels(): void {
  panels.clear();
}
