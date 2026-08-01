/**
 * `@nifrajs/web` search-param engine - the agnostic core behind typed, validated search params. It parses
 * a URL query into a structured object, validates it against a route's Standard Schema (failing CLOSED to
 * defaults on hostile input), serializes it back, and structural-shares successive values so selector
 * reads stay referentially stable. Pure: no DOM, no framework, no fs - it runs identically at server match
 * time and on client navigation, so the two sides cannot drift. See SEARCH-PARAMS-PLAN.md.
 *
 * Not yet re-exported from the package entry: this is the engine the route/server/client wiring (later
 * phases) build on. The public surface (`searchSchema` on a route, `useSearch`, typed `navigate`) lands
 * with that wiring.
 */
import type { InferOutput, StandardSchemaV1 } from "@nifrajs/core/server"

/**
 * Bounds applied while parsing a query string. A search string is attacker-controlled, so it is capped
 * BEFORE an object graph is built from it - defense-in-depth alongside the route schema's own validation.
 */
export interface SearchLimits {
  /** Longest raw query (with or without a leading `?`) that will be parsed; longer fails closed to `{}`. */
  readonly maxLength: number
  /** Most top-level keys that will be kept; keys beyond the cap are dropped. */
  readonly maxKeys: number
  /** Deepest nesting a decoded JSON value may have; deeper values are kept as their raw string instead. */
  readonly maxDepth: number
}

/** Conservative defaults: a 4 KB query, 64 keys, 6 levels of nesting. */
export const DEFAULT_SEARCH_LIMITS: SearchLimits = { maxLength: 4096, maxKeys: 64, maxDepth: 6 }

/**
 * A pluggable query <-> object codec. The default is JSON-first (numbers/booleans/arrays/nested objects
 * survive the round-trip); an app can supply its own (compact, base64, comma-arrays) in a later phase.
 */
export interface SearchCodec {
  /** Parse a raw query (`"?a=1&b=x"` or `"a=1&b=x"`) into a structured object, honoring `limits`. */
  parse(raw: string, limits: SearchLimits): Record<string, unknown>
  /** Serialize a structured object to a query string, including a leading `?` (or `""` when empty). */
  serialize(value: Record<string, unknown>): string
}

// Keys that must never be written from untrusted input: a bracket-assignment to `__proto__` (or the
// others) can pollute Object.prototype. Dropped at every level of a decoded value.
const FORBIDDEN_KEYS = new Set<string>(["__proto__", "prototype", "constructor"])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// True when `value` nests deeper than `remaining` levels (a scalar never does). Used to reject an
// over-deep decoded JSON value back to its raw string rather than store the graph.
function exceedsDepth(value: unknown, remaining: number): boolean {
  if (Array.isArray(value)) return value.some((item) => exceedsDepth(item, remaining - 1))
  if (isPlainObject(value)) {
    if (remaining <= 0) return true
    return Object.values(value).some((item) => exceedsDepth(item, remaining - 1))
  }
  return false
}

// Recursively strip forbidden keys from a decoded value. `JSON.parse('{"__proto__":1}')` yields an OWN
// enumerable `__proto__` property (it does not set the prototype), but a later spread/assign of it would,
// so it is removed here, at the source.
function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize)
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) continue
      out[key] = sanitize(item)
    }
    return out
  }
  return value
}

// One query value: JSON-decode it (so `2` is a number, `true` a boolean, `{...}` an object), falling back
// to the raw string when it is not JSON or nests past the depth cap.
function decodeValue(raw: string, limits: SearchLimits): unknown {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return raw
  }
  if ((isPlainObject(parsed) || Array.isArray(parsed)) && exceedsDepth(parsed, limits.maxDepth)) {
    return raw
  }
  return sanitize(parsed)
}

function encodeValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value)
}

/** The default JSON-first codec. Repeated keys (`?t=a&t=b`) decode to an array; single keys to a value. */
const jsonCodec: SearchCodec = {
  parse(raw, limits) {
    const usp = new URLSearchParams(raw.startsWith("?") ? raw.slice(1) : raw)
    const out: Record<string, unknown> = {}
    let kept = 0
    for (const key of new Set(usp.keys())) {
      if (FORBIDDEN_KEYS.has(key)) continue
      if (++kept > limits.maxKeys) break
      const decoded = usp.getAll(key).map((value) => decodeValue(value, limits))
      out[key] = decoded.length > 1 ? decoded : decoded[0]
    }
    return out
  },
  serialize(value) {
    const usp = new URLSearchParams()
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      if (Array.isArray(item)) for (const element of item) usp.append(key, encodeValue(element))
      else usp.set(key, encodeValue(item))
    }
    const query = usp.toString()
    return query === "" ? "" : `?${query}`
  },
}

/**
 * Parse a raw URL query into a structured object. Fails closed to `{}` when the raw string exceeds
 * `limits.maxLength` (before any parsing work is done).
 */
export function parseSearch(
  raw: string,
  codec: SearchCodec = jsonCodec,
  limits: SearchLimits = DEFAULT_SEARCH_LIMITS,
): Record<string, unknown> {
  if (raw.length > limits.maxLength) return {}
  return codec.parse(raw, limits)
}

/** Serialize a structured search object back to a query string (leading `?`, or `""` when empty). */
export function serializeSearch(
  value: Record<string, unknown>,
  codec: SearchCodec = jsonCodec,
): string {
  return codec.serialize(value)
}

/**
 * The search a route sees for a raw URL query: parsed, then validated against a single `searchSchema`
 * when the route declares one (failing closed to its defaults), or the raw parsed query otherwise. A
 * one-link {@link searchOfChain}; use that directly for a layout+page chain. Both the server (`renderPage`,
 * loader ctx) and the client (the adapter mount) derive search this way, from the same URL + schema, so
 * they produce the identical value - SSR-correct by construction, no serialization.
 */
export function searchOf(
  searchSchema: StandardSchemaV1 | undefined,
  rawSearch: string,
): Record<string, unknown> {
  return searchOfChain([searchSchema], rawSearch)
}

/**
 * The search for a route whose effective schema is a CHAIN - a `_layout` may declare `searchSchema` for
 * shared keys (`?org`, `?theme`) and each page declares its own. The raw query is validated against every
 * schema in the chain (outermost layout first, page last) and their outputs are merged, page-wins on a key
 * conflict (nearest-wins, like `mergeHeads`): validate-each-then-combine, since Standard Schema has no
 * `.merge()`. `undefined` links (a layout with no `searchSchema`) contribute nothing; when the whole chain
 * is empty, the raw parsed query is returned. Fails closed per schema, same as {@link searchOf} (which is
 * this with a one-link chain). The server and the client build the identical chain, so the value matches.
 */
export function searchOfChain(
  schemas: readonly (StandardSchemaV1 | undefined)[],
  rawSearch: string,
): Record<string, unknown> {
  const parsed = parseSearch(rawSearch)
  const defined = schemas.filter((s): s is StandardSchemaV1 => s !== undefined)
  if (defined.length === 0) return parsed
  let out: Record<string, unknown> = {}
  for (const schema of defined) {
    out = { ...out, ...(validateSearch(schema, parsed) as Record<string, unknown>) }
  }
  return out
}

/**
 * Validate a parsed search object against a route's Standard Schema, returning the typed output. Fails
 * CLOSED: on validation issues it retries against an empty object so the schema's per-field defaults apply,
 * and degrades to `{}` only if even that fails - it never throws on hostile input. An async validator is a
 * configuration error (search must validate synchronously, in the render/nav path) and throws loudly.
 */
export function validateSearch<Schema extends StandardSchemaV1>(
  schema: Schema,
  parsed: Record<string, unknown>,
): InferOutput<Schema> {
  const result = schema["~standard"].validate(parsed)
  if (result instanceof Promise) {
    throw new TypeError("[nifra/web] a search schema must validate synchronously")
  }
  if (result.issues === undefined) return result.value as InferOutput<Schema>
  const fallback = schema["~standard"].validate({})
  if (fallback instanceof Promise) {
    throw new TypeError("[nifra/web] a search schema must validate synchronously")
  }
  return (fallback.issues === undefined ? fallback.value : {}) as InferOutput<Schema>
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a)
    return (
      aKeys.length === Object.keys(b).length &&
      aKeys.every((key) => key in b && deepEqual(a[key], b[key]))
    )
  }
  return false
}

/**
 * Structural sharing (shallow-first): return `next`, but reuse `prev`'s reference for every top-level key
 * whose value is deep-equal. When nothing changed, `prev` itself is returned (stable identity), so a
 * selector like `useSearch(s => s.filters)` does not see a change - and a filters-only component does not
 * re-render when an unrelated key (`page`) changes.
 */
export function shareSearch<T>(prev: T, next: T): T {
  if (Object.is(prev, next)) return prev
  if (!isPlainObject(prev) || !isPlainObject(next)) return next
  const out: Record<string, unknown> = {}
  let identical = Object.keys(prev).length === Object.keys(next).length
  for (const [key, after] of Object.entries(next)) {
    if (key in prev && deepEqual(prev[key], after)) {
      out[key] = prev[key]
    } else {
      out[key] = after
      identical = false
    }
  }
  return identical ? prev : (out as T)
}

/**
 * True when two raw queries differ ONLY in keys a route declared client-only (`searchClientKeys`) - the
 * signal a client navigation can update search WITHOUT re-running the loader (re-render, not revalidate:
 * `?tab`, a client-side `?sort` over already-loaded rows, `?modal`). Returns false when a key OUTSIDE the
 * allow-list changed (that key drives data, so the nav must revalidate) and when nothing changed at all (a
 * same-URL nav still revalidates). Fail-safe by construction: an empty allow-list can never return true,
 * so a route that declares no client keys always revalidates - the correct, never-stale default.
 */
export function isClientOnlySearchChange(
  prevRaw: string,
  nextRaw: string,
  clientKeys: readonly string[],
): boolean {
  if (clientKeys.length === 0) return false
  const prev = parseSearch(prevRaw)
  const next = parseSearch(nextRaw)
  const allow = new Set(clientKeys)
  let changed = false
  for (const key of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    if (deepEqual(prev[key], next[key])) continue
    if (!allow.has(key)) return false // a loader-affecting key changed - must revalidate
    changed = true
  }
  return changed // only a real change to a client-only key skips the fetch (else revalidate)
}
