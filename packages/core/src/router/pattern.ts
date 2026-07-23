import { RouteConfigError } from "../errors.ts"

const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const RESERVED_PARAM_NAMES = new Set(["__proto__", "constructor", "prototype"])
const COMPILED_ROUTE_PATTERN: unique symbol = Symbol("nifra.compiled-route-pattern")

export type RoutePatternSegment =
  | { readonly kind: "static"; readonly value: string }
  | { readonly kind: "param"; readonly name: string }
  | { readonly kind: "wildcard"; readonly name: string }

/**
 * Compiled route grammar shared by runtime routers, browser navigation, mocks, and adapters.
 *
 * The result, its two arrays, and every segment are frozen because consumers share one instance. In
 * particular, a segment must not diverge from the lazily cached regex after first match. The measured
 * sub-microsecond cost per route is paid only at registration and preserves that runtime invariant.
 */
export interface CompiledRoutePattern {
  readonly [COMPILED_ROUTE_PATTERN]: true
  readonly pattern: string
  readonly segments: readonly RoutePatternSegment[]
  readonly paramNames: readonly string[]
}

export type RoutePatternMatch =
  | { readonly matched: true; readonly params: Record<string, string> }
  | { readonly matched: false; readonly reason: "not-found" | "malformed" }

/**
 * Regex per compiled pattern, derived on first use. The core trie matches by descending segments and
 * never asks for one, so building it during {@link compileRoutePattern} would charge every server's
 * boot for the browser/mock adapters alone. Keyed by the frozen pattern, so the cache dies with it.
 */
const REGEX_CACHE = new WeakMap<CompiledRoutePattern, RegExp>()

function regexOf(compiled: CompiledRoutePattern): RegExp {
  let regex = REGEX_CACHE.get(compiled)
  if (regex === undefined) {
    if (compiled[COMPILED_ROUTE_PATTERN] !== true) {
      throw new TypeError("route pattern was not produced by compileRoutePattern()")
    }
    const parts = compiled.segments.map((segment) =>
      segment.kind === "static"
        ? escapeRegex(segment.value)
        : segment.kind === "param"
          ? "([^/]+)"
          : "(.+)",
    )
    regex = new RegExp(parts.length === 0 ? "^/$" : `^/${parts.join("/")}$`)
    REGEX_CACHE.set(compiled, regex)
  }
  return regex
}

function validParamName(name: string): boolean {
  return PARAM_NAME.test(name) && !RESERVED_PARAM_NAMES.has(name)
}

/**
 * Explain WHY a parameter name was rejected, in the terms the author was thinking in.
 *
 * The grammar is per-segment: a segment is wholly static or wholly a parameter, so everything after
 * the colon is the name. `/v/:id.json` therefore asks for a parameter literally named `id.json`,
 * which is not what anyone means by it — but the bare "invalid parameter" that produces reads as a
 * typo rather than as a rule, leaving the author to guess whether the dot, the length, or the casing
 * was the problem. Naming the actual limitation and showing the two ways out is the difference
 * between a five-second fix and a trip to the source.
 */
function paramNameHint(name: string): string {
  if (RESERVED_PARAM_NAMES.has(name)) return ` — "${name}" is reserved (prototype key)`
  if (name.length === 0) return ` — ":" needs a name after it`
  // A trailing literal is the common intent (`:file.txt`, `:id-v2`), and the one case where the bare
  // message misleads: the author sees a typo where the real answer is a grammar rule.
  if (/^[A-Za-z_][A-Za-z0-9_]*./.test(name)) {
    return ` — a segment is wholly static or wholly a parameter, so everything after ":" is the name. Split the literal into its own segment, or capture the segment and split it in the handler`
  }
  return ` — a name must match ${PARAM_NAME.source}`
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^()|[\]\\{}$]/g, "\\$&")
}

/** Parse and validate Nifra's strict route grammar once. Trailing slashes remain significant. */
export function compileRoutePattern(pattern: string): CompiledRoutePattern {
  if (pattern.length === 0 || pattern.charCodeAt(0) !== 47 /* / */) {
    throw new RouteConfigError("INVALID_PATH", `path must start with "/": "${pattern}"`)
  }
  const raw = pattern === "/" ? [] : pattern.slice(1).split("/")
  const segments: RoutePatternSegment[] = []
  const paramNames: string[] = []
  for (let i = 0; i < raw.length; i++) {
    const value = raw[i]!
    if (value.charCodeAt(0) === 58 /* : */) {
      const name = value.slice(1)
      if (!validParamName(name)) {
        throw new RouteConfigError(
          "INVALID_PARAM_NAME",
          `invalid parameter ":${name}" in "${pattern}"${paramNameHint(name)}`,
        )
      }
      if (paramNames.includes(name)) {
        throw new RouteConfigError(
          "DUPLICATE_PARAM",
          `duplicate parameter ":${name}" in "${pattern}"`,
        )
      }
      paramNames.push(name)
      segments.push(Object.freeze({ kind: "param", name }))
      continue
    }
    if (value.charCodeAt(0) === 42 /* * */) {
      if (i !== raw.length - 1) {
        throw new RouteConfigError(
          "WILDCARD_NOT_LAST",
          `wildcard must be the final segment in "${pattern}"`,
        )
      }
      const name = value.length === 1 ? "*" : value.slice(1)
      if (name !== "*" && !validParamName(name)) {
        throw new RouteConfigError(
          "INVALID_PARAM_NAME",
          `invalid wildcard "*${name}" in "${pattern}"`,
        )
      }
      if (paramNames.includes(name)) {
        throw new RouteConfigError(
          "DUPLICATE_PARAM",
          `duplicate parameter "${name}" in "${pattern}"`,
        )
      }
      paramNames.push(name)
      segments.push(Object.freeze({ kind: "wildcard", name }))
      continue
    }
    segments.push(Object.freeze({ kind: "static", value }))
  }
  const compiled = Object.freeze({
    [COMPILED_ROUTE_PATTERN]: true,
    pattern,
    segments: Object.freeze(segments),
    paramNames: Object.freeze(paramNames),
  }) as CompiledRoutePattern
  return compiled
}

/** Core precedence: static > param > wildcard at the first differing segment, independent of order. */
export function compareRoutePatternSpecificity(
  left: CompiledRoutePattern,
  right: CompiledRoutePattern,
): number {
  const length = Math.max(left.segments.length, right.segments.length)
  for (let i = 0; i < length; i++) {
    const a = left.segments[i]
    const b = right.segments[i]
    if (a === undefined || b === undefined) return b === undefined ? -1 : 1
    const aWeight = a.kind === "static" ? 3 : a.kind === "param" ? 2 : 1
    const bWeight = b.kind === "static" ? 3 : b.kind === "param" ? 2 : 1
    if (aWeight !== bWeight) return bWeight - aWeight
  }
  return 0
}

/** Decode router captures under one rule. Plain values take the zero-allocation path; malformed
 * escapes return `null`, allowing HTTP to emit 400 while client navigation declines the match. */
export function decodeRouteParams(raw: Record<string, string>): Record<string, string> | null {
  let out: Record<string, string> | undefined
  for (const key in raw) {
    const value = raw[key]!
    if (!value.includes("%")) continue
    try {
      out ??= { ...raw }
      out[key] = decodeURIComponent(value)
    } catch {
      return null
    }
  }
  return out ?? raw
}

/** Match one compiled pattern and return decoded captures. The caller decides cross-pattern order. */
export function matchRoutePattern(
  compiled: CompiledRoutePattern,
  pathname: string,
): RoutePatternMatch {
  const match = regexOf(compiled).exec(pathname)
  if (match === null) return { matched: false, reason: "not-found" }
  const params: Record<string, string> = {}
  for (let i = 0; i < compiled.paramNames.length; i++) {
    params[compiled.paramNames[i]!] = match[i + 1] ?? ""
  }
  const decoded = decodeRouteParams(params)
  return decoded === null
    ? { matched: false, reason: "malformed" }
    : { matched: true, params: decoded }
}
