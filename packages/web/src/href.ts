import {
  type CompiledRoutePattern,
  compileRoutePattern,
  fillRoutePath,
  isSameOriginPath,
} from "@nifrajs/core/pattern"
import type { Href, RouteTable } from "./navigation.ts"
import { ROUTE_SLOTS_PARAM, withRouteSlots } from "./route-slots.ts"
import { serializeSearch } from "./search.ts"

type Pattern = keyof RouteTable & string

type ParamsOf<K extends Pattern> = RouteTable[K] extends { readonly params: infer Params }
  ? Params
  : never
type SearchOfRoute<K extends Pattern> = RouteTable[K] extends { readonly search: infer Search }
  ? Search
  : never

type SlotRegistryOf<K extends Pattern> = RouteTable[K] extends { readonly slots: infer Slots }
  ? Slots
  : Readonly<Record<never, never>>
type SlotNamesOf<K extends Pattern> = keyof SlotRegistryOf<K> & string
type SlotTargetOf<
  K extends Pattern,
  Name extends SlotNamesOf<K>,
> = SlotRegistryOf<K>[Name] extends readonly (infer Target extends string)[]
  ? Href<Extract<Target, Pattern>>
  : never
type SlotOptions<K extends Pattern> = [SlotNamesOf<K>] extends [never]
  ? { readonly slots?: never }
  : {
      readonly slots?: Readonly<{
        [Name in SlotNamesOf<K>]?: SlotTargetOf<K, Name> | null
      }>
    }

// A route without params is typed `Record<string, never>`, whose keys are all strings.
type ParamsOption<K extends Pattern> = string extends keyof ParamsOf<K>
  ? { readonly params?: never }
  : { readonly params: ParamsOf<K> }

/**
 * What {@link href} takes: the route's pattern as `to`, its `params` (required when the pattern has
 * any, absent when it has none), the route's `search` as its `searchSchema` outputs it, and the `hash`
 * without its `#`.
 */
export type HrefOptions<K extends Pattern> = {
  readonly to: K
  readonly search?: SearchOfRoute<K> | undefined
  readonly hash?: string | undefined
} & ParamsOption<K> &
  SlotOptions<K>

// Route patterns are a closed set for typed callers, so the cache stays small; an untyped caller could
// pass any string, so it is bounded and starts over when full.
const MAX_COMPILED_PATTERNS = 1024
const compiledPatterns = new Map<string, CompiledRoutePattern>()

function compiled(pattern: string): CompiledRoutePattern {
  let entry = compiledPatterns.get(pattern)
  if (entry === undefined) {
    entry = compileRoutePattern(pattern)
    if (compiledPatterns.size >= MAX_COMPILED_PATTERNS) compiledPatterns.clear()
    compiledPatterns.set(pattern, entry)
  }
  return entry
}

function brand<Pattern extends string = string>(path: string): Href<Pattern> {
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Href is a phantom brand; both callers have just built the string from a pattern or checked it with isSameOriginPath
  return path as Href<Pattern>
}

// HrefOptions with the route table's key and value types erased: what the body reads.
type UntypedHrefOptions = {
  readonly to: string
  readonly params?: Readonly<Record<string, string | undefined>>
  readonly search?: Record<string, unknown> | undefined
  readonly hash?: string | undefined
  readonly slots?: Readonly<Record<string, string | null>>
}

function fragment(hash: string): string {
  try {
    return `#${encodeURI(hash)}`
  } catch {
    throw new TypeError("[nifra/web] href: the hash holds an unpaired surrogate")
  }
}

/**
 * The in-app URL for a route: the pattern filled with `params` (each value encoded as one path
 * segment), then `search` serialized as the router reads it, then the `hash`. `to` is a key of the
 * generated route table, so a misspelt route, a missing or misspelt param and a `search` that breaks the
 * route's schema are compile errors; the result is an {@link Href}, the only thing `navigate` takes.
 *
 * ```ts
 * navigate(href({ to: "/users/:id", params: { id }, search: { tab: "posts" }, hash: "top" }))
 * ```
 *
 * A param that is missing, empty, or holds a value no path segment can carry (`.`, `..`, an unpaired
 * surrogate) throws a `TypeError` naming it, in production too: a link built from it would go
 * somewhere else. The result is a pure function of its input, so the server and the browser build the
 * same string. A link to a path built elsewhere is {@link rawHref}; one to another site is a plain `<a>`.
 */
export function href<K extends Pattern>(options: HrefOptions<K>): Href<K> {
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: HrefOptions<K> is this shape with the route table's types in place of string and unknown
  const { to, params, search, hash, slots } = options as UntypedHrefOptions
  const filled = fillRoutePath(compiled(to), params ?? {})
  if (!filled.ok) {
    const problems = [
      ...filled.missing.map((name) => `"${name}" is missing or empty`),
      ...filled.invalid.map(
        (name) =>
          `"${name}" holds a value no path segment can carry ("." or ".." or an unpaired surrogate)`,
      ),
    ]
    throw new TypeError(`[nifra/web] href({ to: ${JSON.stringify(to)} }): ${problems.join("; ")}`)
  }
  let url = filled.path
  if (search !== undefined) url += serializeSearch(search)
  if (new URLSearchParams(url.slice(url.indexOf("?") + 1)).has(ROUTE_SLOTS_PARAM)) {
    throw new TypeError(`[nifra/web] ${ROUTE_SLOTS_PARAM} is reserved for route-slot state`)
  }
  if (slots !== undefined) {
    const targets = Object.fromEntries(
      Object.entries(slots).filter((entry): entry is [string, string] => entry[1] !== null),
    )
    url = withRouteSlots(url, targets)
  }
  if (hash !== undefined && hash !== "") url += fragment(hash)
  return brand<K>(url)
}

/**
 * An {@link Href} for a same-origin path built elsewhere: a CMS link, a `@nifrajs/content` page, a public
 * file such as `/llms.txt`. The path is returned as written, never encoded, after `isSameOriginPath`
 * (the check `redirect()` makes) accepts it: one leading `/`, not `//`, no backslash and no control
 * character. Anything else throws a `TypeError`. A route of this app is {@link href}; another site is a
 * plain `<a href>`.
 */
export function rawHref(path: string): Href {
  if (typeof path !== "string" || !isSameOriginPath(path)) {
    throw new TypeError(
      `[nifra/web] rawHref(${JSON.stringify(path)}) is not a same-origin path. Use a path beginning with "/" (not "//", no backslash or control character); a link to another site is a plain <a href>.`,
    )
  }
  return brand(path)
}
