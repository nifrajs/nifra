import type { Href, RouteTable } from "./navigation.ts"

/** Reserved query-key prefix carrying independently navigable route-slot targets. */
export const ROUTE_SLOT_QUERY_PREFIX = "slot."

/** Keep URL state small and request fan-out bounded. */
export const MAX_ROUTE_SLOTS = 4
export const MAX_ROUTE_SLOT_STATE_CHARS = 4096
export const MAX_ROUTE_SLOT_TARGET_CHARS = 1024
export const MAX_ROUTE_SLOT_NAMES = 8
export const MAX_ROUTE_SLOT_PATTERNS = 32

const SENTINEL_ORIGIN = "https://nifra.invalid"
const SLOT_NAME = /^[a-z][a-z0-9_-]{0,31}$/

export type RouteSlotRegistry = Readonly<Record<string, readonly string[]>>
export type RouteSlotTargets = Readonly<Record<string, string>>
type NamesInRoute<R> = R extends { readonly slots: infer Slots } ? keyof Slots : never
/** Union of slot names registered by the generated route manifest. */
export type RouteSlotName = NamesInRoute<RouteTable[keyof RouteTable]> & string
/** A typed route URL that a registered route slot may display. */
export type RouteSlotTarget = Href<keyof RouteTable & string>

/** Preserve route-module slot declarations in the generated, per-route `RouteTable`. */
export type RouteSlotPatternsOf<T> = T extends { readonly routeSlots: infer Slots }
  ? Slots extends Readonly<Record<string, readonly string[]>>
    ? Slots
    : Readonly<Record<never, never>>
  : Readonly<Record<never, never>>

export class RouteSlotStateError extends TypeError {
  readonly code: "malformed" | "unknown_slot" | "unknown_route" | "invalid_target" | "too_large"

  constructor(code: RouteSlotStateError["code"], message = "[nifra/web] invalid route-slot state") {
    super(message)
    this.name = "RouteSlotStateError"
    this.code = code
  }
}

function stateError(code: RouteSlotStateError["code"], message?: string): RouteSlotStateError {
  return new RouteSlotStateError(code, message)
}

function nullRecord<T>(): Record<string, T> {
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: A fresh null-prototype record has no inherited keys; callers add only names validated against SLOT_NAME.
  return Object.create(null) as Record<string, T>
}

function urlOf(path: string): URL {
  try {
    return new URL(path, SENTINEL_ORIGIN)
  } catch {
    throw stateError("malformed")
  }
}

function rawSearchOf(path: string): string | undefined {
  const hash = path.indexOf("#")
  const beforeHash = hash < 0 ? path : path.slice(0, hash)
  const query = beforeHash.indexOf("?")
  return query < 0 ? undefined : beforeHash.slice(query + 1)
}

function rawKeyStartsWithRouteSlotPrefix(rawKey: string): boolean {
  let decoded = ""
  let index = 0
  while (index < rawKey.length && decoded.length < ROUTE_SLOT_QUERY_PREFIX.length) {
    if (rawKey[index] === "%") {
      const byte = rawKey.slice(index + 1, index + 3)
      if (!/^[0-9a-f]{2}$/i.test(byte)) return false
      decoded += String.fromCharCode(Number.parseInt(byte, 16))
      index += 3
    } else {
      decoded += rawKey[index] === "+" ? " " : rawKey[index]
      index++
    }
    if (!ROUTE_SLOT_QUERY_PREFIX.startsWith(decoded)) return false
  }
  return decoded === ROUTE_SLOT_QUERY_PREFIX
}

function slotNameFromSegment(segment: string): string | undefined {
  const equals = segment.indexOf("=")
  const rawKey = equals < 0 ? segment : segment.slice(0, equals)
  if (rawKey.length > (ROUTE_SLOT_QUERY_PREFIX.length + 32) * 3)
    return rawKeyStartsWithRouteSlotPrefix(rawKey) ? "" : undefined
  try {
    const key = decodeURIComponent(rawKey.replace(/\+/g, " "))
    return key.startsWith(ROUTE_SLOT_QUERY_PREFIX)
      ? key.slice(ROUTE_SLOT_QUERY_PREFIX.length)
      : undefined
  } catch {
    return rawKeyStartsWithRouteSlotPrefix(rawKey) ? "" : undefined
  }
}

/** Check raw query text for framework-owned slot keys, including percent-encoded names. */
export function hasRouteSlotsSearch(search: string): boolean {
  let start = 0
  while (start <= search.length) {
    const ampersand = search.indexOf("&", start)
    const end = ampersand < 0 ? search.length : ampersand
    if (slotNameFromSegment(search.slice(start, end)) !== undefined) return true
    if (ampersand < 0) return false
    start = ampersand + 1
  }
  return false
}

/** Reject origin changes, fragments, traversal, ambiguous encoded separators and nested slot state. */
function containsAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

export function normalizeRouteSlotTarget(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw stateError("invalid_target")
  if (value.length > MAX_ROUTE_SLOT_TARGET_CHARS) throw stateError("too_large")
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    value.includes("#") ||
    containsAsciiControl(value)
  )
    throw stateError("invalid_target")

  // Inspect the raw path before WHATWG URL parsing, which normalizes literal and encoded dot segments.
  const queryAt = value.indexOf("?")
  const rawPathname = queryAt === -1 ? value : value.slice(0, queryAt)
  for (const rawSegment of rawPathname.split("/")) {
    let segment: string
    try {
      segment = decodeURIComponent(rawSegment)
    } catch {
      throw stateError("invalid_target")
    }
    if (segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\"))
      throw stateError("invalid_target")
  }

  const url = urlOf(value)
  if (url.origin !== SENTINEL_ORIGIN || url.hash !== "") throw stateError("invalid_target")

  if (hasRouteSlotsSearch(url.search.slice(1))) throw stateError("invalid_target")
  return `${url.pathname}${url.search}`
}

function orderedTargets(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw stateError("malformed")
  const own = Object.keys(value)
  if (own.length > MAX_ROUTE_SLOTS) throw stateError("too_large")
  const slots = nullRecord<string>()
  for (const name of own.sort()) {
    if (!SLOT_NAME.test(name)) throw stateError("malformed")
    slots[name] = normalizeRouteSlotTarget(Reflect.get(value, name))
  }
  return slots
}

/** Parse and strictly validate flat `slot.<name>=<target>` query values. */
export function parseRouteSlots(path: string): RouteSlotTargets {
  const search = rawSearchOf(path)
  if (search === undefined || !hasRouteSlotsSearch(search))
    return Object.freeze(nullRecord<string>())
  const slots = nullRecord<string>()
  let totalChars = 0
  let count = 0
  let start = 0
  while (start <= search.length) {
    const ampersand = search.indexOf("&", start)
    const end = ampersand < 0 ? search.length : ampersand
    const segment = search.slice(start, end)
    const name = slotNameFromSegment(segment)
    if (name !== undefined) {
      if (!SLOT_NAME.test(name)) throw stateError("malformed")
      if (Object.hasOwn(slots, name)) throw stateError("malformed")
      count++
      if (count > MAX_ROUTE_SLOTS) throw stateError("too_large")
      totalChars += segment.length
      if (totalChars > MAX_ROUTE_SLOT_STATE_CHARS) throw stateError("too_large")
      const equals = segment.indexOf("=")
      if (equals < 0) throw stateError("invalid_target")
      let target: string
      try {
        target = decodeURIComponent(segment.slice(equals + 1).replace(/\+/g, " "))
      } catch {
        throw stateError("invalid_target")
      }
      slots[name] = normalizeRouteSlotTarget(target)
    }
    if (ampersand < 0) break
    start = ampersand + 1
  }
  return Object.freeze(orderedTargets(slots))
}

/** Replace the slot query values while preserving unrelated query text byte for byte. */
export function withRouteSlots(path: string, targets: RouteSlotTargets): string {
  const url = urlOf(path)
  if (url.origin !== SENTINEL_ORIGIN) throw stateError("invalid_target")
  const slots = orderedTargets(targets)
  const search = rawSearchOf(path) ?? ""
  const hasSlots = hasRouteSlotsSearch(search)
  if (Object.keys(slots).length === 0 && !hasSlots) return path
  const preservedSearch = stripRouteSlotsSearch(search)
  const serializedSlots = Object.entries(slots)
    .map(([name, target]) => `${ROUTE_SLOT_QUERY_PREFIX}${name}=${encodeURIComponent(target)}`)
    .join("&")
  if (serializedSlots.length > MAX_ROUTE_SLOT_STATE_CHARS) throw stateError("too_large")
  const nextSearch =
    preservedSearch.length === 0
      ? serializedSlots
      : serializedSlots.length === 0
        ? preservedSearch
        : `${preservedSearch}&${serializedSlots}`
  const hashIndex = path.indexOf("#")
  const hash = hashIndex < 0 ? "" : path.slice(hashIndex)
  return `${url.pathname}${nextSearch.length === 0 ? "" : `?${nextSearch}`}${hash}`
}

/** Change a single slot while retaining the other URL-addressed slots. */
export function setRouteSlot(path: string, name: string, target: string | null): string {
  if (!SLOT_NAME.test(name)) throw stateError("unknown_slot")
  const next = { ...parseRouteSlots(path) }
  if (target === null) delete next[name]
  else next[name] = normalizeRouteSlotTarget(target)
  return withRouteSlots(path, next)
}

/** Remove framework-owned state before the active page's loader sees its search params. */
function isRouteSlotsParameter(segment: string): boolean {
  return slotNameFromSegment(segment) !== undefined
}

/** Removes only the reserved route-slot key without reparsing or rewriting the other query text. */
export function stripRouteSlotsSearch(search: string): string {
  let start = 0
  let found = false
  while (start <= search.length) {
    const ampersand = search.indexOf("&", start)
    const end = ampersand < 0 ? search.length : ampersand
    if (isRouteSlotsParameter(search.slice(start, end))) found = true
    if (ampersand < 0) break
    start = ampersand + 1
  }
  if (!found) return search

  let output = ""
  let kept = 0
  start = 0
  while (start <= search.length) {
    const ampersand = search.indexOf("&", start)
    const end = ampersand < 0 ? search.length : ampersand
    const segment = search.slice(start, end)
    if (!isRouteSlotsParameter(segment)) {
      if (kept > 0) output += "&"
      output += segment
      kept++
    }
    if (ampersand < 0) break
    start = ampersand + 1
  }
  return output
}

export function stripRouteSlots(path: string): string {
  const hashIndex = path.indexOf("#")
  const beforeHash = hashIndex < 0 ? path : path.slice(0, hashIndex)
  const hash = hashIndex < 0 ? "" : path.slice(hashIndex)
  const queryIndex = beforeHash.indexOf("?")
  if (queryIndex < 0) return path

  const search = beforeHash.slice(queryIndex + 1)
  const stripped = stripRouteSlotsSearch(search)
  if (stripped === search) return path
  return `${beforeHash.slice(0, queryIndex)}${stripped.length === 0 ? "" : `?${stripped}`}${hash}`
}

/** Validate route-module declarations once they meet the runtime manifest. */
export function normalizeRouteSlotRegistry(
  value: unknown,
  knownPatterns: ReadonlySet<string>,
): RouteSlotRegistry {
  if (value === undefined) return Object.freeze(nullRecord<readonly string[]>())
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw stateError("malformed", "[nifra/web] routeSlots must be a plain record of route patterns")
  const names = Object.keys(value)
  if (names.length > MAX_ROUTE_SLOT_NAMES) throw stateError("too_large")
  const registry = nullRecord<readonly string[]>()
  for (const name of names.sort()) {
    if (!SLOT_NAME.test(name)) throw stateError("malformed")
    const patterns: unknown = Reflect.get(value, name)
    if (
      !Array.isArray(patterns) ||
      patterns.length === 0 ||
      patterns.length > MAX_ROUTE_SLOT_PATTERNS
    )
      throw stateError(
        "malformed",
        `[nifra/web] routeSlots.${name} must list one or more route patterns`,
      )
    const unique = new Set<string>()
    for (const pattern of patterns) {
      if (typeof pattern !== "string" || !knownPatterns.has(pattern) || unique.has(pattern))
        throw stateError(
          "unknown_route",
          `[nifra/web] routeSlots.${name} references an unknown or duplicate route pattern`,
        )
      unique.add(pattern)
    }
    registry[name] = Object.freeze([...unique])
  }
  return Object.freeze(registry)
}

/** Validate URL state against the current page's registry and the route manifest. */
export function validateRouteSlotTargets(
  targets: RouteSlotTargets,
  registry: RouteSlotRegistry,
  matchPath: (pathname: string) => { readonly pattern: string } | null,
): void {
  for (const [name, target] of Object.entries(targets)) {
    const allowed = registry[name]
    if (allowed === undefined) throw stateError("unknown_slot")
    const matched = matchPath(urlOf(target).pathname)
    if (matched === null) throw stateError("unknown_route")
    if (!allowed.includes(matched.pattern)) throw stateError("unknown_route")
  }
}
