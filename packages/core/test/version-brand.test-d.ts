/**
 * Type-level proof that `Server` carries the feature version of the core copy that declared it.
 *
 * Two copies of `@nifrajs/core` in one build (a linked sibling repo, a hoisting split) are two
 * unrelated `Server` types. The brand makes the version part of the type, so the copy an app talks
 * to is readable on hover and assertable in a test; `nifra doctor` names the two install paths.
 *
 * Each assertion is exported so `noUnusedLocals` treats it as used.
 */
import type { Equal, Expect } from "@nifrajs/test-utils"
import { server, type VERSION } from "../src/index.ts"
import type { NifraFeatureVersion } from "../src/server/server.ts"

const app = server()

// The brand is `major.minor` of the package's own VERSION - patch releases never re-brand.
export type _BrandIsFeatureVersion = Expect<
  Equal<(typeof app)["__nifraCoreVersion"], NifraFeatureVersion>
>
export type _BrandTracksVersion = Expect<
  Equal<VersionPrefix extends `${NifraFeatureVersion}.` ? true : false, true>
>
type VersionPrefix = typeof VERSION extends `${infer Major}.${infer Minor}.${string}`
  ? `${Major}.${Minor}.`
  : never

// A server type branded by another copy of core is rejected on the brand.
declare const otherCopy: Omit<typeof app, "__nifraCoreVersion"> & {
  readonly __nifraCoreVersion: "1.0"
}
// @ts-expect-error core version mismatch: "1.0" is not this copy's feature version
export const mismatched: typeof app = otherCopy
