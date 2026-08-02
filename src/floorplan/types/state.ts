export type AppMode = 'drafting' | 'viewing';
export type ViewMode = 'editor' | 'shadow' | 'heatmap';

/**
 * A tool id. Open, not a closed union: core owns the four below and every other tool comes
 * from a module runtime's `ToolDescriptor`, namespaced `${moduleId}.${verb}`. The union used
 * to name `'light'`, which is exactly the kind of thing `src/floorplan/` may not know.
 */
export type Tool = string;

export const CORE_TOOL_SELECT = 'select';
export const CORE_TOOL_DRAW = 'draw';
export const CORE_TOOL_DOOR = 'door';
export const CORE_TOOL_OBSTACLE = 'obstacle';

export const CORE_TOOL_IDS: readonly Tool[] = [
  CORE_TOOL_SELECT,
  CORE_TOOL_DRAW,
  CORE_TOOL_DOOR,
  CORE_TOOL_OBSTACLE,
];

/** A tool that is not core's belongs to whichever module contributed it. */
export function isCoreTool(tool: Tool): boolean {
  return CORE_TOOL_IDS.includes(tool);
}

export type UnitFormat = 'feet-inches' | 'inches';
export type LightRadiusVisibility = 'selected' | 'always';

// Helper function to migrate legacy 'never' value to current type
export function migrateLightRadiusVisibility(value: unknown): LightRadiusVisibility {
  if (value === 'never') {
    return 'selected';
  }
  if (value === 'selected' || value === 'always') {
    return value;
  }
  // Fallback to default
  return 'selected';
}

export interface DisplayPreferences {
  useFractions: boolean;
  snapThreshold: number;
  unitFormat: UnitFormat;
  gridSnapEnabled: boolean;
  gridSize: number; // in feet
  lightRadiusVisibility: LightRadiusVisibility;
}

export interface PropertiesPanelConfig {
  visible: boolean;
  position: { x: number; y: number };
}

export const DEFAULT_DISPLAY_PREFERENCES: DisplayPreferences = {
  useFractions: true,
  snapThreshold: 0.5,
  unitFormat: 'feet-inches',
  gridSnapEnabled: false,
  gridSize: 0.5, // 6 inches
  lightRadiusVisibility: 'selected',
};
