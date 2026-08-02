import { writable, derived, get } from 'svelte/store';
import type { LightDefinition } from '../../floorplan/types';
import { DEFAULT_LIGHT_DEFINITIONS } from '../../floorplan/types';
import type { IESData } from './IESParser';

/**
 * The fixture **picker library**: what the user can choose from, persisted under its own
 * local-storage key and never part of a document.
 *
 * Since phase 3b a document carries the closure of definitions its fixtures reference
 * (`LightingData.definitions`) and that copy is authoritative for rendering, so importing no
 * longer merges anything into this store as a side effect of decoding. `adoptIncomingDefinitions`
 * in `lightingStore.ts` is the explicit post-`open` step that offers unknown incoming ids here.
 */
const STORAGE_KEY = 'lumen2d_light_definitions';

function loadCustomDefinitions(): LightDefinition[] {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) return [];
    const parsed = JSON.parse(data) as LightDefinition[];
    // Filter out any that might have invalid data
    return parsed.filter((d) => d.id && d.name);
  } catch (e) {
    console.error('Failed to load custom light definitions:', e);
    return [];
  }
}

function saveCustomDefinitions(definitions: LightDefinition[]): void {
  try {
    // Only save custom definitions (those with custom- prefix)
    const customDefs = definitions.filter((d) => d.id.startsWith('custom-'));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(customDefs));
  } catch (e) {
    console.error('Failed to save custom light definitions:', e);
  }
}

// Load custom definitions and merge with defaults
const customDefs = loadCustomDefinitions();
const initialDefinitions = [...DEFAULT_LIGHT_DEFINITIONS, ...customDefs];

export const lightDefinitions = writable<LightDefinition[]>(initialDefinitions);

// Save to localStorage whenever definitions change
lightDefinitions.subscribe((defs) => {
  saveCustomDefinitions(defs);
});

export const selectedDefinitionId = writable<string>(DEFAULT_LIGHT_DEFINITIONS[0].id);

derived([lightDefinitions, selectedDefinitionId], ([$definitions, $selectedId]) => {
  return $definitions.find((d) => d.id === $selectedId) ?? $definitions[0];
});

export function getDefinitionById(id: string): LightDefinition | undefined {
  return get(lightDefinitions).find((d) => d.id === id);
}

export function addLightDefinition(definition: Omit<LightDefinition, 'id'>): LightDefinition {
  const newDef: LightDefinition = {
    ...definition,
    id: `custom-${Date.now()}`,
  };
  lightDefinitions.update((defs) => [...defs, newDef]);
  return newDef;
}

export function addLightDefinitionFromIES(
  iesData: IESData,
  warmth: number = 3000
): LightDefinition {
  const name = iesData.manufacturer ? `${iesData.manufacturer} - ${iesData.name}` : iesData.name;

  // Create a descriptive name with key specs
  const displayName = `${name} (${iesData.lumens}lm, ${iesData.beamAngle}°)`;

  return addLightDefinition({
    name: displayName,
    lumen: iesData.lumens,
    beamAngle: iesData.beamAngle,
    warmth,
  });
}

export function updateLightDefinition(
  id: string,
  updates: Partial<Omit<LightDefinition, 'id'>>
): void {
  lightDefinitions.update((defs) => defs.map((d) => (d.id === id ? { ...d, ...updates } : d)));
}

export function deleteLightDefinition(id: string): void {
  // Don't allow deleting if it's the last one
  const defs = get(lightDefinitions);
  if (defs.length <= 1) return;

  // Don't allow deleting built-in definitions
  if (!id.startsWith('custom-')) return;

  lightDefinitions.update((defs) => defs.filter((d) => d.id !== id));

  // If the deleted definition was selected, select the first one
  if (get(selectedDefinitionId) === id) {
    selectedDefinitionId.set(get(lightDefinitions)[0].id);
  }
}

export function setSelectedDefinition(id: string): void {
  selectedDefinitionId.set(id);
}
