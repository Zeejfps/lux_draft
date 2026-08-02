/**
 * Dev-only backstop for immutability.
 *
 * `DeepReadonly` at the exported boundaries is the primary defense; it cannot see through
 * `JSON.parse`, `structuredClone`, or an `as` cast, which is exactly where mutable documents
 * enter. Freezing every document the reducer produces turns "a handler mutated its input and
 * returned it" — which would make the reducer's equality check trivially true and land a real
 * edit with no history entry — into a throw at the mutation site.
 *
 * Every call site guards with a bare `if (import.meta.env.DEV)` so the whole thing is
 * statically eliminated from production. The helper keeps **no retained state** (no seen-set,
 * no cache), or tree-shaking could not drop it. Cycles are impossible in document data, which
 * is serializable by construction; an already-frozen object short-circuits.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;

  Object.freeze(value);
  for (const key of Object.keys(value as object)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
