/**
 * Deep immutability at the type level.
 *
 * `Readonly<T>` is shallow — it would let `doc.geometry.doors.push(d)` type-check, which is
 * the exact mutation the dev deep-freeze exists to catch at runtime. `DeepReadonly` is the
 * static half of that pair.
 *
 * Phase 1b deferred this to 3a because retrofitting `Session.document` in the same commit that
 * replaced the store would have forced a cast at every handler return and every renderer read.
 * It is introduced here for the codec/module API, whose signatures the plan already writes in
 * these terms; `Session` and `EditorDocument` still use bare `readonly` fields. Widening it to
 * the whole document is a mechanical, separately-reviewable change.
 *
 * Note the direction that makes this cheap: a mutable `T` is assignable to `DeepReadonly<T>`,
 * so a call site holding a plain `EditorDocument` needs no cast to pass it in. Only going the
 * other way (a codec producing a fresh mutable value from a readonly input) needs one, and
 * those casts are confined to `withModule` and the command wrapper.
 */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends ReadonlyArray<infer U>
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

/**
 * Drop `DeepReadonly` from a value the caller is about to rebuild.
 *
 * Deliberately narrow and deliberately ugly: every use is a place where a fresh mutable copy
 * is being constructed from a readonly input, and it should be visible in review.
 */
export function asMutable<T>(value: DeepReadonly<T>): T {
  return value as T;
}
