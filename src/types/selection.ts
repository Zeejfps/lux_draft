/**
 * What the user has selected. One value, so selecting anything replaces everything —
 * cross-clearing is structural rather than six manual clears.
 *
 * Phase 1b introduces the type and the `Session.selection` field that holds it. The six
 * parallel selection stores in `appStore.ts` are still the source of truth until **phase 2**
 * migrates the call sites onto this union and adds `defineSelection` / the panel registry.
 */
export type Selection =
  | { kind: 'none' }
  | { kind: 'wall'; id: string }
  | { kind: 'vertex'; indices: number[] }
  | { kind: 'obstacle'; id: string }
  | { kind: 'obstacleVertex'; obstacleId: string; indices: number[] }
  | { kind: 'door'; id: string }
  /** Extension point. Constructed only via `SelectionKind` (phase 2). */
  | { kind: 'module'; moduleId: string; type: string; payload: unknown };

export const NO_SELECTION: Selection = { kind: 'none' };
