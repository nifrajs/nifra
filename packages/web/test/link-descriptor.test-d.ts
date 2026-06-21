/**
 * Type-level contract for {@link LinkDescriptor} and `Meta["link"]`. Verified by `tsc` (the root
 * program typechecks the per-package test directories), not run. Exported so `noUnusedLocals` treats
 * each assertion as used.
 *
 * The regression these guard: `Meta["link"]` was `ReadonlyArray<Record<string, string>>`, so a typed
 * partial like `{ rel, href, hreflang }` (an `interface` with optional fields) was NOT assignable —
 * `Record<string, string>` demands *every* property be a present string. `LinkDescriptor` fixes that
 * by spelling the common attrs as optional + an index signature for custom/`data-*` attrs.
 */
import type { Expect, Extends, Not } from "@nifrajs/test-utils"
import type { fontPreload } from "../src/fonts.ts"
import type { LinkDescriptor, Meta } from "../src/manifest.ts"

// The motivating shape: a partial alternate-language link is assignable to LinkDescriptor…
type Alternate = { rel: "alternate"; href: "/x"; hreflang: "en" }
export type _AlternateIsLink = Expect<Extends<Alternate, LinkDescriptor>>

// …and into a `meta.link` array (the actual call site — `export const meta = { link: [...] }`).
export type _AlternateIntoMetaLink = Expect<Extends<readonly Alternate[], Meta["link"]>>

// A bare `{ rel, href }` (the most minimal canonical/preconnect tag) is assignable — every typed
// field is optional, so a partial is fine. This was the exact bug: a partial used to be rejected.
export type _MinimalRelHref = Expect<Extends<{ rel: "canonical"; href: "/" }, LinkDescriptor>>

// Custom + `data-*` attributes pass through the index signature without a cast.
export type _CustomAttr = Expect<Extends<{ rel: "x"; "data-test": "y" }, LinkDescriptor>>

// Boolean attributes (e.g. `disabled`) are allowed by the descriptor.
export type _BooleanAttr = Expect<Extends<{ rel: "stylesheet"; disabled: true }, LinkDescriptor>>

// A descriptor value is `string | boolean | undefined` — never an arbitrary object, so a nested
// object can't slip in as an attribute value (it would silently mis-render).
export type _NoObjectValues = Expect<Not<Extends<{ rel: { nested: true } }, LinkDescriptor>>>

// `fontPreload` returns a LinkDescriptor, so its result drops straight into `meta.link`.
export type _FontPreloadIsLink = Expect<Extends<ReturnType<typeof fontPreload>, LinkDescriptor>>
