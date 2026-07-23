import { RouteConfigError } from "../errors.ts"

const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const RESERVED_PARAM_NAMES = new Set(["__proto__", "constructor", "prototype"])
const COMPILED_ROUTE_PATTERN: unique symbol = Symbol("nifra.compiled-route-pattern")

export type RoutePatternSegment =
  | { readonly kind: "static"; readonly value: string }
  | { readonly kind: "param"; readonly name: string }
  | { readonly kind: "wildcard"; readonly name: string }
  /** A segment that is part literal, part parameter: `:key.txt`, `feed.:format`, `v:major.:minor`. */
  | { readonly kind: "mixed"; readonly parts: readonly MixedPart[] }

/** One piece of a {@link RoutePatternSegment} of kind `mixed`, in left-to-right order. */
export type MixedPart =
  | { readonly t: "lit"; readonly v: string }
  | { readonly t: "param"; readonly name: string }

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
          : segment.kind === "mixed"
            ? mixedSegmentSource(segment.parts)
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
  // No "a segment is wholly static or wholly a parameter" case here any more: mixed segments made
  // that message obsolete. `:id.json` was the shape it explained, and `:id.json` now compiles.
  return ` — a name must match ${PARAM_NAME.source}`
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^()|[\]\\{}$]/g, "\\$&")
}

/**
 * Split a segment containing `:` into literal and parameter parts.
 *
 * The param name is the LONGEST run matching {@link PARAM_NAME}'s body after each `:`; everything
 * else in the segment is literal. So `:key.txt` is `[param key][lit ".txt"]`. Choosing a greedy scan
 * on the existing sigil rather than a new `{key}.txt` syntax is a safety argument, not a taste one:
 * every segment this newly accepts currently THROWS `INVALID_PARAM_NAME`, so no pattern that compiles
 * today can change meaning.
 *
 * Returns `undefined` when the segment holds no parameter at all, so a literal colon
 * (`/v1/things:batchGet` - legal in a URL path) stays a plain static segment.
 */
function splitMixed(value: string): MixedPart[] | undefined {
  const parts: MixedPart[] = []
  let literal = ""
  let sawParam = false
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== ":") {
      literal += value[i]
      continue
    }
    const rest = value.slice(i + 1)
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest)?.[0]
    // A `:` not followed by a valid name start is literal text, not a malformed parameter.
    if (name === undefined) {
      literal += ":"
      continue
    }
    const paramEnd = i + 1 + name.length
    const previous = i > 0 ? value[i - 1] : undefined
    const precededByBoundary = previous === undefined || !/[A-Za-z0-9_]/.test(previous)
    // Preserve established RPC-style literals such as `things:batchGet`. A colon embedded after an
    // identifier and running to the end is literal; mixed params remain unambiguous at segment start,
    // after punctuation (`post-:id`), or when followed by a literal suffix (`v:major.json`).
    if (!precededByBoundary && paramEnd === value.length) {
      literal += `:${name}`
      i += name.length
      continue
    }
    if (literal !== "") {
      parts.push({ t: "lit", v: literal })
      literal = ""
    }
    parts.push({ t: "param", name })
    sawParam = true
    i += name.length
  }
  if (!sawParam) return undefined
  if (literal !== "") parts.push({ t: "lit", v: literal })
  return parts
}

/** The regex source matching one segment's worth of a mixed pattern, with a capture per parameter. */
export function mixedSegmentSource(parts: readonly MixedPart[]): string {
  let source = ""
  for (const part of parts) {
    // LAZY (`+?`), not greedy. A greedy capture swallows the trailing literal, so `/:key.txt` against
    // `/abc.txt` would capture `abc.txt` and then fail to match `\.txt`. With `^…$` anchoring, the
    // lazy form still yields `abc.txt` for `/abc.txt.txt` - the anchor forces the LAST `.txt` to be
    // the literal. `+?` and not `*?`: an empty capture must not match (see the empty-segment rule).
    source += part.t === "lit" ? escapeRegex(part.v) : "([^/]+?)"
  }
  return source
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
    // A leading `:` whose name run spans the WHOLE segment is a plain parameter - the untouched fast
    // path. When it does not (`:key.txt`), the segment is mixed and is handled below; but a leading
    // `:` that yields no usable name at all (`:9lives`, `:`) was clearly meant as a parameter, so it
    // still fails here rather than being silently reinterpreted as literal text.
    if (value.charCodeAt(0) === 58 /* : */ && !validParamName(value.slice(1))) {
      if (splitMixed(value) === undefined) {
        const name = value.slice(1)
        throw new RouteConfigError(
          "INVALID_PARAM_NAME",
          `invalid parameter ":${name}" in "${pattern}"${paramNameHint(name)}`,
        )
      }
    } else if (value.charCodeAt(0) === 58 /* : */) {
      const name = value.slice(1)
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
    // A segment holding a `:` anywhere other than the front is part literal, part parameter. Checked
    // last so the wholly-static and wholly-param fast paths above are untouched.
    const mixed = value.includes(":") ? splitMixed(value) : undefined
    if (mixed !== undefined) {
      for (const part of mixed) {
        if (part.t !== "param") continue
        if (!validParamName(part.name)) {
          throw new RouteConfigError(
            "INVALID_PARAM_NAME",
            `invalid parameter ":${part.name}" in "${pattern}"${paramNameHint(part.name)}`,
          )
        }
        // Duplicates must be rejected WITHIN a segment (`/:a.:a`) as well as across segments,
        // or two captures would race for one params key.
        if (paramNames.includes(part.name)) {
          throw new RouteConfigError(
            "DUPLICATE_PARAM",
            `duplicate parameter ":${part.name}" in "${pattern}"`,
          )
        }
        // Pushed left-to-right so `paramNames` stays aligned with regex capture order.
        paramNames.push(part.name)
      }
      segments.push(Object.freeze({ kind: "mixed", parts: Object.freeze(mixed) }))
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

/** Weight for {@link compareRoutePatternSpecificity}. A mixed segment constrains more than a bare
 * param (it pins literal text) and less than a fully static one, so it sits between them. */
const SPECIFICITY: Readonly<Record<RoutePatternSegment["kind"], number>> = {
  static: 4,
  mixed: 3,
  param: 2,
  wildcard: 1,
}

/** Total ordering for mixed segment shapes, shared by the trie and regex-based routers. */
export function compareMixedPartsSpecificity(
  left: readonly MixedPart[],
  right: readonly MixedPart[],
): number {
  const literalWeight = (parts: readonly MixedPart[]): number =>
    parts.reduce((sum, part) => (part.t === "lit" ? sum + part.v.length : sum), 0)
  const weightDifference = literalWeight(right) - literalWeight(left)
  if (weightDifference !== 0) return weightDifference

  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i++) {
    const a = left[i]
    const b = right[i]
    if (a === undefined || b === undefined) return b === undefined ? -1 : 1
    if (a.t !== b.t) return a.t === "lit" ? -1 : 1
    if (a.t === "lit" && b.t === "lit") {
      if (a.v.length !== b.v.length) return b.v.length - a.v.length
      const lexical = a.v.localeCompare(b.v)
      if (lexical !== 0) return lexical
    }
  }

  return mixedSegmentSource(left).localeCompare(mixedSegmentSource(right))
}

/** Core precedence: static > mixed > param > wildcard at the first differing segment, independent of
 * registration order. */
export function compareRoutePatternSpecificity(
  left: CompiledRoutePattern,
  right: CompiledRoutePattern,
): number {
  const length = Math.max(left.segments.length, right.segments.length)
  for (let i = 0; i < length; i++) {
    const a = left.segments[i]
    const b = right.segments[i]
    if (a === undefined || b === undefined) return b === undefined ? -1 : 1
    const aWeight = SPECIFICITY[a.kind]
    const bWeight = SPECIFICITY[b.kind]
    if (aWeight !== bWeight) return bWeight - aWeight
    if (a.kind === "mixed" && b.kind === "mixed") {
      const mixed = compareMixedPartsSpecificity(a.parts, b.parts)
      if (mixed !== 0) return mixed
    }
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
