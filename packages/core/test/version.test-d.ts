/**
 * Type-level tests. These never run; they are verified by `tsc --noEmit`.
 * If inference regresses, the build fails here even when runtime tests pass —
 * which is the point, since inference IS the product.
 *
 * Each assertion is exported so `noUnusedLocals` treats it as used.
 */
import type { Equal, Expect } from "@nifrajs/test-utils"
import type { VERSION, Version } from "../src/index.ts"

// VERSION must stay a NARROW, semver-shaped string literal (so consumers can pin it at the type level)
// — but NOT a specific value, which would break this test on every release bump. We assert the shape
// and the narrowing without naming the version.
export type _VersionIsSemverLiteral = Expect<
  typeof VERSION extends `${number}.${number}.${number}` ? true : false
>
// `string` is NOT assignable to a literal type, so this stays `false` only while VERSION is a literal;
// widening it to `string` (dropping `as const`) flips it to `true` and fails the build.
export type _VersionIsNarrowLiteral = Expect<
  Equal<string extends typeof VERSION ? true : false, false>
>
export type _VersionTypeMatches = Expect<Equal<Version, typeof VERSION>>
