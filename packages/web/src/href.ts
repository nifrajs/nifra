import {
  type CompiledRoutePattern,
  compileRoutePattern,
  fillRoutePath,
  isSameOriginPath,
} from "@nifrajs/core/pattern"
import type {
  Href,
  RouteParamsOf as ParamsOf,
  RouteTablePattern as Pattern,
  RouteTable,
  RouteSearchInOf as SearchOfRoute,
} from "./navigation.ts"
import { hasRouteSlotsSearch, ROUTE_SLOT_QUERY_PREFIX, withRouteSlots } from "./route-slots.ts"
import { serializeSearch } from "./search.ts"

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

// A route without params is typed with no keys (the generator) or `Record<string, never>` (a hand-written
// table), whose keys are all strings.
type ParamsOption<K extends Pattern> = [keyof ParamsOf<K>] extends [never]
  ? { readonly params?: never }
  : string extends keyof ParamsOf<K>
    ? { readonly params?: never }
    : { readonly params: ParamsOf<K> }

/**
 * What {@link href} takes: the route's pattern as `to`, its `params` (required when the pattern has
 * any, absent when it has none), the route's `search` as its `searchSchema` accepts it (a defaulted field
 * may be left out), and the `hash` without its `#`.
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

/**
 * What `href()` and `rawHref()` return for input they refuse. It starts with a control character, so
 * `isSameOriginPath` rejects it: `Link`, `Navigate`, `navigate` and `redirect` all treat it as no
 * destination. Held by a plain `<a>` in any adapter's template, a click, a modified click and a middle
 * click are cancelled by the click handler of `installHistory` once the page is hydrated. Before that,
 * or without scripts, it percent-encodes to a path no route of the app names, so the failure is a 404
 * (or the page of a catch-all or dynamic route, such as `/:id`, that matches any one segment) and never
 * another page's link. An anchor that must never navigate leaves its `href` off:
 * `href={isInertHref(link) ? undefined : link}`.
 */
export const INERT_HREF: Href = brand("/\u0001nifra-invalid-href")

/** Whether `value` is what `href()` and `rawHref()` return for input they refused. */
export function isInertHref(value: string): boolean {
  return value === INERT_HREF
}

/** One refused call, as {@link onHrefRefused} hands it over. It never holds a param, hash or path value. */
export interface HrefRefusal {
  readonly call: "href" | "rawHref"
  /** The route pattern `href()` was given; undefined for `rawHref`. */
  readonly route?: string
  /** What was refused, in words: the same text the default log writes. */
  readonly message: string
}

let reporter: ((refusal: HrefRefusal) => void) | undefined

/**
 * Take over what happens when `href()` or `rawHref()` refuses a value. `report` runs for every refusal,
 * in place of the default `console.error`, so an app can send them to its error tracker or count them;
 * pass `console.error` to keep the default as well. Returns a function that removes it. One reporter at
 * a time: a second call replaces the first. A throw from `report` is swallowed, since a link must not
 * cost the render. The refusal holds no value: a CMS link can carry a token into a log.
 */
export function onHrefRefused(report: (refusal: HrefRefusal) => void): () => void {
  reporter = report
  return () => {
    if (reporter === report) reporter = undefined
  }
}

const MAX_LOGGED = 64
const logged = new Set<string>()

/**
 * Refuse input without throwing: a param, hash or path that comes from data (a database row, a CMS
 * link) must cost its own link, never the render. The default log remembers the last 64 distinct
 * messages and writes each once, so a page of rows with the same bad param is one line; past 64 it
 * starts over, so a longer cycle of messages can repeat. A {@link onHrefRefused} reporter hears every
 * refusal.
 */
function refuse<Pattern extends string = string>(
  call: HrefRefusal["call"],
  to: string | undefined,
  message: string,
): Href<Pattern> {
  if (reporter !== undefined) {
    try {
      reporter(to === undefined ? { call, message } : { call, route: to, message })
    } catch {
      // a broken reporter costs its own report, never the link
    }
  } else if (!logged.has(message)) {
    if (logged.size >= MAX_LOGGED) logged.clear()
    logged.add(message)
    console.error(message)
  }
  return brand<Pattern>(INERT_HREF)
}

function fragment(hash: string): string | undefined {
  try {
    return `#${encodeURI(hash)}`
  } catch {
    return undefined
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
 * surrogate), a `hash` with an unpaired surrogate, a `search` key reserved for route-slot state, and a
 * slot target that was itself refused come from data, so they do not throw: the result is the inert
 * `Href`, which every consumer (`Link`, `Navigate`, `navigate`, and a click on a plain `<a>`) ignores,
 * and a `console.error` (once per distinct message, within a bounded memory; see {@link onHrefRefused}
 * to take over) names the route and the param, never the value. A link built from such a value would go somewhere else, so no link is built.
 * The result is a pure function of its input, so the server and the browser build the same string. A
 * link to a path built elsewhere is {@link rawHref}; one to another site is a plain `<a>`.
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
    return refuse(
      "href",
      to,
      `[nifra/web] href({ to: ${JSON.stringify(to)} }): ${problems.join("; ")}`,
    )
  }
  let url = filled.path
  if (search !== undefined) url += serializeSearch(search)
  const queryStart = url.indexOf("?")
  if (queryStart >= 0 && hasRouteSlotsSearch(url.slice(queryStart + 1))) {
    return refuse(
      "href",
      to,
      `[nifra/web] href({ to: ${JSON.stringify(to)} }): query keys beginning with ${ROUTE_SLOT_QUERY_PREFIX} are reserved for route-slot state`,
    )
  }
  if (slots !== undefined) {
    // A target the child `href()` refused has nowhere to go, so neither does the parent.
    for (const target of Object.values(slots)) {
      if (target !== null && isInertHref(target)) {
        return refuse(
          "href",
          to,
          `[nifra/web] href({ to: ${JSON.stringify(to)} }): a slot target is a link that was refused`,
        )
      }
    }
    const targets = Object.fromEntries(
      Object.entries(slots).filter((entry): entry is [string, string] => entry[1] !== null),
    )
    url = withRouteSlots(url, targets)
  }
  if (hash !== undefined && hash !== "") {
    const written = fragment(hash)
    if (written === undefined)
      return refuse(
        "href",
        to,
        `[nifra/web] href({ to: ${JSON.stringify(to)} }): the hash holds an unpaired surrogate`,
      )
    url += written
  }
  return brand<K>(url)
}

/**
 * An {@link Href} for a same-origin path built elsewhere: a CMS link, a `@nifrajs/content` page, a public
 * file such as `/llms.txt`. The path is returned as written, never encoded, after `isSameOriginPath`
 * (the check `redirect()` makes) accepts it: one leading `/`, not `//`, no backslash and no control
 * character. Anything else is a path from data this function cannot vouch for, so it does not throw:
 * the result is the inert `Href` that `Link`, `Navigate` and `navigate` ignore, with a `console.error`
 * that leaves the value out. A route of this app is {@link href}; another site is a plain `<a href>`.
 */
export function rawHref(path: string): Href {
  if (typeof path !== "string" || !isSameOriginPath(path)) {
    return refuse(
      "rawHref",
      undefined,
      `[nifra/web] rawHref: the path is not a same-origin one. Use a path beginning with "/" (not "//", no backslash or control character); a link to another site is a plain <a href>.`,
    )
  }
  return brand(path)
}
