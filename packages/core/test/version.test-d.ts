/**
 * Type-level tests. These never run; they are verified by `tsc --noEmit`.
 * If inference regresses, the build fails here even when runtime tests pass —
 * which is the point, since inference IS the product.
 *
 * Each assertion is exported so `noUnusedLocals` treats it as used.
 */
import type { Equal, Expect } from "@nifrajs/test-utils"
import type { VERSION, Version } from "../src/index.ts"

export type _VersionIsLiteral = Expect<Equal<typeof VERSION, "0.0.0">>
export type _VersionTypeMatches = Expect<Equal<Version, "0.0.0">>
