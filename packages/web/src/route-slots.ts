import type { Href, RouteTable } from "./navigation.ts"

/** Reserved query key carrying independently navigable route-slot state. */
export const ROUTE_SLOTS_PARAM = "__nifra_slots"

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

function urlOf(path: string): URL {
  try {
    return new URL(path, SENTINEL_ORIGIN)
  } catch {
    throw stateError("malformed")
  }
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

  if (url.searchParams.has(ROUTE_SLOTS_PARAM)) throw stateError("invalid_target")
  return `${url.pathname}${url.search}`
}

function orderedTargets(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw stateError("malformed")
  const own = Object.keys(value)
  if (own.length > MAX_ROUTE_SLOTS) throw stateError("too_large")
  const slots: Record<string, string> = Object.create(null) as Record<string, string>
  for (const name of own.sort()) {
    if (!SLOT_NAME.test(name)) throw stateError("malformed")
    slots[name] = normalizeRouteSlotTarget(Reflect.get(value, name))
  }
  return slots
}

function canonicalPayload(slots: Record<string, string>): string {
  return JSON.stringify({ v: 1, slots })
}

/** Parse and strictly validate the one canonical route-slot query value. */
export function parseRouteSlots(path: string): RouteSlotTargets {
  const url = urlOf(path)
  const values = url.searchParams.getAll(ROUTE_SLOTS_PARAM)
  if (values.length === 0) return Object.freeze(Object.create(null) as Record<string, string>)
  if (values.length !== 1 || values[0]!.length > MAX_ROUTE_SLOT_STATE_CHARS)
    throw stateError(values.length > 1 ? "malformed" : "too_large")

  let payload: unknown
  try {
    payload = JSON.parse(values[0]!) as unknown
  } catch {
    throw stateError("malformed")
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload))
    throw stateError("malformed")
  const keys = Object.keys(payload)
  if (
    keys.length !== 2 ||
    !keys.includes("v") ||
    !keys.includes("slots") ||
    Reflect.get(payload, "v") !== 1
  )
    throw stateError("malformed")
  const slots = orderedTargets(Reflect.get(payload, "slots"))
  if (canonicalPayload(slots) !== values[0]) throw stateError("malformed")
  return Object.freeze(slots)
}

/** Replace the route-slot query value, preserving all unrelated query parameters and the hash. */
export function withRouteSlots(path: string, targets: RouteSlotTargets): string {
  const url = urlOf(path)
  const slots = orderedTargets(targets)
  url.searchParams.delete(ROUTE_SLOTS_PARAM)
  if (Object.keys(slots).length > 0) {
    const payload = canonicalPayload(slots)
    if (payload.length > MAX_ROUTE_SLOT_STATE_CHARS) throw stateError("too_large")
    url.searchParams.set(ROUTE_SLOTS_PARAM, payload)
  }
  return `${url.pathname}${url.search}${url.hash}`
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
export function stripRouteSlots(path: string): string {
  const url = urlOf(path)
  url.searchParams.delete(ROUTE_SLOTS_PARAM)
  return `${url.pathname}${url.search}${url.hash}`
}

/** Validate route-module declarations once they meet the runtime manifest. */
export function normalizeRouteSlotRegistry(
  value: unknown,
  knownPatterns: ReadonlySet<string>,
): RouteSlotRegistry {
  if (value === undefined)
    return Object.freeze(Object.create(null) as Record<string, readonly string[]>)
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw stateError("malformed", "[nifra/web] routeSlots must be a plain record of route patterns")
  const names = Object.keys(value)
  if (names.length > MAX_ROUTE_SLOT_NAMES) throw stateError("too_large")
  const registry: Record<string, readonly string[]> = Object.create(null) as Record<
    string,
    readonly string[]
  >
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
