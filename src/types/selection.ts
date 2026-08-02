/**
 * What the user has selected. **One value** on `Session`, so selecting anything replaces
 * everything — cross-clearing is structural rather than six manual clears.
 *
 * Phase 1b introduced the type and the `Session.selection` field. Phase 2 made it the single
 * source of truth: the six parallel `appStore` writables are gone, and every producer and
 * consumer goes through this file.
 */

/**
 * `multi` is a phase-2 addition to the plan's union. Box selection and grab mode operate on
 * room vertices *and* lighting fixtures at once (which is why phase 1a needed compound
 * commands), and no single-variant shape can express that. Members are never `none` and
 * never `multi` — `combineSelection` is the only constructor and it flattens.
 */
export type Selection =
  | { kind: 'none' }
  | { kind: 'wall'; id: string }
  | { kind: 'vertex'; indices: number[] }
  | { kind: 'obstacle'; id: string }
  | { kind: 'obstacleVertex'; obstacleId: string; indices: number[] }
  | { kind: 'door'; id: string }
  /** Extension point. Constructed only via `SelectionKind`. */
  | { kind: 'module'; moduleId: string; type: string; payload: unknown }
  /** Heterogeneous selection. Built only by `combineSelection`. */
  | { kind: 'multi'; parts: readonly SelectionPart[] };

/** One selected thing. The atoms a `multi` is made of. */
export type SelectionPart = Exclude<Selection, { kind: 'none' } | { kind: 'multi' }>;

export const NO_SELECTION: Selection = { kind: 'none' };

/**
 * Namespace for selections the core owns. Module selections use their own module id, so a
 * panel key never collides across the two.
 */
export const CORE_MODULE_ID = 'core';

const NO_PARTS: readonly SelectionPart[] = [];

// ============================================
// Panel keys
// ============================================

/**
 * `${moduleId}.${type}`. Panel registration and panel dispatch both go through this, so they
 * cannot disagree.
 */
export function panelKeyOf(part: SelectionPart): string {
  return part.kind === 'module'
    ? `${part.moduleId}.${part.type}`
    : `${CORE_MODULE_ID}.${part.kind}`;
}

/** Every panel key this selection asks for, in selection order, deduplicated. */
export function selectionPanelKeys(selection: Selection): string[] {
  const keys: string[] = [];
  for (const part of selectionParts(selection)) {
    const key = panelKeyOf(part);
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

// ============================================
// Structure
// ============================================

export function selectionParts(selection: Selection): readonly SelectionPart[] {
  if (selection.kind === 'none') return NO_PARTS;
  if (selection.kind === 'multi') return selection.parts;
  return [selection];
}

export function isEmptySelection(selection: Selection): boolean {
  return selectionParts(selection).length === 0;
}

/**
 * The only constructor of a heterogeneous selection. Flattens, drops `none`, and keeps the
 * **first** part for any given panel key — so `combineSelection([next, ...previousParts])`
 * reads as "replace this kind, keep the rest".
 */
export function combineSelection(parts: readonly Selection[]): Selection {
  const flat: SelectionPart[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    for (const atom of selectionParts(part)) {
      const key = panelKeyOf(atom);
      if (seen.has(key)) continue;
      seen.add(key);
      flat.push(atom);
    }
  }
  if (flat.length === 0) return NO_SELECTION;
  if (flat.length === 1) return flat[0];
  return { kind: 'multi', parts: flat };
}

function firstPart<K extends SelectionPart['kind']>(
  selection: Selection,
  kind: K
): Extract<SelectionPart, { kind: K }> | null {
  for (const part of selectionParts(selection)) {
    if (part.kind === kind) return part as Extract<SelectionPart, { kind: K }>;
  }
  return null;
}

// ============================================
// Core accessors
// ============================================

export function getSelectedWallId(selection: Selection): string | null {
  return firstPart(selection, 'wall')?.id ?? null;
}

export function getSelectedDoorId(selection: Selection): string | null {
  return firstPart(selection, 'door')?.id ?? null;
}

/** An obstacle-vertex selection implies its obstacle is selected, exactly as before. */
export function getSelectedObstacleId(selection: Selection): string | null {
  return (
    firstPart(selection, 'obstacle')?.id ??
    firstPart(selection, 'obstacleVertex')?.obstacleId ??
    null
  );
}

export function getSelectedVertexIndices(selection: Selection): readonly number[] {
  return firstPart(selection, 'vertex')?.indices ?? [];
}

export function getSelectedObstacleVertexIndices(selection: Selection): readonly number[] {
  return firstPart(selection, 'obstacleVertex')?.indices ?? [];
}

/** Shift-click semantics: toggle when adding, replace otherwise. */
export function toggleMember<T>(members: readonly T[], value: T, addToSelection: boolean): T[] {
  if (!addToSelection) return [value];
  return members.includes(value) ? members.filter((m) => m !== value) : [...members, value];
}

// ============================================
// defineSelection
// ============================================

/**
 * A module's selection type. The module id and type string are written **once**, and `make`
 * and `match` are generated from that one pair, so a producer and a consumer cannot drift
 * apart during a refactor.
 */
export interface SelectionKind<T> {
  readonly moduleId: string;
  readonly type: string;
  /** `${moduleId}.${type}`. The panel registry key. */
  readonly panelKey: string;
  make(payload: T): Selection;
  /** The payload if this selection contains one of these, else null. Looks inside `multi`. */
  match(selection: Selection): T | null;
}

export function defineSelection<T>(
  moduleId: string,
  type: string,
  parse: (payload: unknown) => T | null
): SelectionKind<T> {
  if (moduleId === CORE_MODULE_ID) {
    throw new Error(`'${CORE_MODULE_ID}' is reserved for core selections`);
  }
  const panelKey = `${moduleId}.${type}`;
  return {
    moduleId,
    type,
    panelKey,
    make(payload: T): Selection {
      return { kind: 'module', moduleId, type, payload };
    },
    match(selection: Selection): T | null {
      for (const part of selectionParts(selection)) {
        if (part.kind !== 'module') continue;
        if (part.moduleId !== moduleId || part.type !== type) continue;
        const parsed = parse(part.payload);
        if (parsed !== null) return parsed;
      }
      return null;
    },
  };
}
