import { get } from 'svelte/store';
import type { RoomState, LightDefinition } from '../types';
import type { EditorDocument } from '../types/document';
import { lightDefinitions } from '../stores/lightDefinitionsStore';
import { toLegacyRoomState } from './legacyDocumentAdapter';

export interface ExportData {
  version: 1 | 2;
  roomState: RoomState;
  lightDefinitions: LightDefinition[];
}

export function exportToJSON(doc: EditorDocument): void {
  const exportData = createExportData(doc);
  const json = JSON.stringify(exportData, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `lumen2d-design-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function getJSONString(doc: EditorDocument): string {
  const exportData = createExportData(doc);
  return JSON.stringify(exportData, null, 2);
}

function createExportData(doc: EditorDocument): ExportData {
  // Get all current light definitions
  const allDefinitions = get(lightDefinitions);

  // Find which custom definitions are actually used by lights in this room
  const usedDefinitionIds = new Set(
    doc.lights
      .map((light) => light.definitionId)
      .filter((id): id is string => id !== undefined && id.startsWith('custom-'))
  );

  // Only include custom definitions that are used
  const usedCustomDefinitions = allDefinitions.filter((def) => usedDefinitionIds.has(def.id));

  return {
    version: 2,
    roomState: toLegacyRoomState(doc),
    lightDefinitions: usedCustomDefinitions,
  };
}
