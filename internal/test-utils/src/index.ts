/**
 * Zero-runtime type-level assertion helpers, used in `*.test-d.ts` files and
 * verified by `tsc --noEmit`. Home-grown rather than a dependency because the
 * whole set is ~10 lines and teaching the mechanics is part of the point.
 */

/** Compile error unless `T` is exactly `true`. Wrap every assertion in this. */
export type Expect<T extends true> = T

/**
 * Strict type equality. Uses the conditional-inference trick so that
 * `Equal<{ a: 1 }, { a: 1 }>` is `true` but `Equal<string, "a">` is `false`,
 * and — unlike a naive `extends` — it does not collapse `any`.
 */
export type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

/** `true` when `A` is assignable to `B`. */
export type Extends<A, B> = A extends B ? true : false

/** Boolean negation at the type level. */
export type Not<T extends boolean> = T extends true ? false : true
