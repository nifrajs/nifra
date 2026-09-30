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

/**
 * One piece of a {@link RoutePatternSegment} of kind `mixed`, in left-to-right order. A parameter
 * written with a constraint (`:id{[0-9]+}`) carries it as `c`; a segment that is one constrained
 * parameter and nothing else is a `mixed` segment with that single part.
 */
export type MixedPart =
  | { readonly t: "lit"; readonly v: string }
  | { readonly t: "param"; readonly name: string; readonly c?: ParamConstraint | undefined }

/**
 * What a constrained parameter accepts, parsed from the `{...}` after its name.
 *
 * A constraint is one of two things:
 *   - a character class with an optional count: `[0-9]+`, `[a-z0-9-]{3,32}`, `\d{4}`, `\w+`. The class
 *     is `[...]` holding characters, `x-y` ranges, `\d` and `\w`, or a bare `\d` / `\w`. The count is
 *     `+` (one or more), `{n}`, `{n,}` or `{n,m}` with `n` at least 1; with no count the value is
 *     exactly one character.
 *   - a list of two or more literal values: `en|fr|de`.
 *
 * Anything else in braces is not a constraint, and the braces stay the literal text they always were.
 *
 * A value is tested as it appears in the request path, before percent-decoding, and only ASCII can
 * satisfy a constraint. `%` is never accepted, so a value that passes holds no escape and reaches the
 * handler as exactly the text that was tested.
 */
export interface ParamConstraint {
  /** The text between the braces, as written. */
  readonly source: string
  /** The accepted values, for a list (`en|fr|de`), in the order written. */
  readonly oneOf?: readonly string[] | undefined
  /** The same values as the keys of an object with no prototype, which is what a value is looked up in. */
  readonly index?: Readonly<Record<string, 1>> | undefined
  /**
   * For a class: which ASCII codes it holds. 128 characters, the one at index `code` being `1` when
   * the class holds that code and `0` when it does not. All `0` for a list.
   */
  readonly mask: string
  /** For a class: the fewest and the most characters a value may have. */
  readonly min: number
  readonly max: number
  /** How many characters the class holds, or how many values the list has. */
  readonly size: number
  /**
   * What the constraint accepts, spelled one way: `\d+` and `[0-9]+` share a key, and so do `a|b`
   * and `b|a`. Two parameters with one key are the same parameter to the router.
   */
  readonly key: string
}

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

/** What {@link matchRoutePattern} needs per compiled pattern: the whole-path regex, and for each mixed
 * segment its shape and, when it has a constraint, its parts (both indexed like `segments`,
 * `undefined` elsewhere). */
interface PatternMatcher {
  readonly regex: RegExp
  readonly shapes: readonly (MixedSegmentShape | undefined)[]
  readonly checked: readonly (readonly MixedPart[] | undefined)[]
}

/**
 * Matcher per compiled pattern, derived on first use. The core trie matches by descending segments
 * and never asks for one, so building it during {@link compileRoutePattern} would charge every
 * server's boot for the browser/mock adapters alone. Keyed by the frozen pattern, so the cache dies
 * with it.
 */
const MATCHER_CACHE = new WeakMap<CompiledRoutePattern, PatternMatcher>()

function matcherOf(compiled: CompiledRoutePattern): PatternMatcher {
  let matcher = MATCHER_CACHE.get(compiled)
  if (matcher === undefined) {
    if (compiled[COMPILED_ROUTE_PATTERN] !== true) {
      throw new TypeError("route pattern was not produced by compileRoutePattern()")
    }
    // A mixed segment is captured WHOLE here and taken apart by `matchMixedSegment` afterwards. Its
    // parameters never become separate lazy groups in this regex: several of those in one segment
    // make the engine retry every split of the text between them, and the text is the request's.
    const parts = compiled.segments.map((segment) =>
      segment.kind === "static"
        ? escapeRegex(segment.value)
        : segment.kind === "wildcard"
          ? "(.+)"
          : "([^/]+)",
    )
    matcher = {
      regex: new RegExp(parts.length === 0 ? "^/$" : `^/${parts.join("/")}$`),
      shapes: compiled.segments.map((segment) =>
        segment.kind === "mixed" ? mixedSegmentShape(segment.parts) : undefined,
      ),
      checked: compiled.segments.map((segment) =>
        segment.kind === "mixed" ? constrainedParts(segment.parts) : undefined,
      ),
    }
    MATCHER_CACHE.set(compiled, matcher)
  }
  return matcher
}

// No pattern text ever becomes a RegExp. This recognises the constraint grammar, anchored at a `{`:
// group 1 is a class, 2 its count (3 and 4 the bounds), 5 a list of values.
const CONSTRAINT =
  /^\{(?:(\[(?:[\w.~!$&'()+,;=@-]|\\[dw])+]|\\[dw])(\+|\{(\d+)(?:,(\d*))?})?|([\w.~-]+(?:\|[\w.~-]+)+))}/

/**
 * Parse the constraint `text` starts with, or `undefined` when it starts with none. `text` begins at
 * the `{` that follows a parameter name; the constraint read is `source.length + 2` characters long.
 */
export function paramConstraint(text: string): ParamConstraint | undefined {
  const found = CONSTRAINT.exec(text)
  if (found === null) return undefined
  const oneOf = found[5]?.split("|")
  const table: number[] = new Array(128).fill(0)
  let min = 1
  let max = 1
  const set = (from: number, to: number): unknown => table.fill(1, from, to + 1)
  // A list has no class to read: `body` is empty for it, and so is the count.
  const body = found[1] ?? ""
  const members = body.length > 2 ? body.slice(1, -1) : body
  for (let i = 0; i < members.length; i++) {
    const from = members.charCodeAt(i)
    let to = from
    if (from === 92 /* \ */) {
      if (members[++i] === "w") {
        set(65, 90)
        set(95, 95)
        set(97, 122)
      }
      set(48, 57)
      continue
    }
    // `x-y` is a range when something follows the hyphen; a hyphen at either end is itself.
    if (members[i + 1] === "-" && i + 2 < members.length) {
      i += 2
      to = members.charCodeAt(i)
      // A range that takes in `%` would let a percent-escape through, and the handler would then
      // see a value other than the one tested.
      if (to === 92 || to < from || (from < 37 && to > 37)) return undefined
    }
    set(from, to)
  }
  if (found[2] !== undefined) {
    min = Number(found[3] ?? 1)
    max = found[2] === "+" || found[4] === "" ? Infinity : Number(found[4] ?? found[3])
    if (min < 1 || max < min) return undefined
  }
  const mask = table.join("")
  let index: Record<string, 1> | undefined
  if (oneOf) {
    index = Object.create(null) as Record<string, 1>
    for (const value of oneOf) index[value] = 1
  }
  return Object.freeze({
    source: found[0].slice(1, -1),
    oneOf: oneOf && Object.freeze(oneOf),
    index: index && Object.freeze(index),
    mask,
    min,
    max,
    size: oneOf ? oneOf.length : mask.split("1").length - 1,
    key: oneOf ? [...oneOf].sort().join("|") : `${mask},${min},${max}`,
  })
}

/**
 * Whether `value` satisfies `constraint`: one lookup for a list, and for a class a length check and
 * then one lookup per character. A parameter with no constraint accepts every value.
 *
 * Both lookups go to a string or to a frozen object, never to a frozen array: an engine that stores
 * a frozen array sparsely reads it several times slower, and this runs on every request.
 */
function satisfies(constraint: ParamConstraint | undefined, value: string): boolean {
  if (!constraint) return true
  if (constraint.index) return constraint.index[value] === 1
  let i = value.length
  if (i < constraint.min || i > constraint.max) return false
  const mask = constraint.mask
  // A code past 127 reads outside the mask, which is `NaN` and so not a `1`.
  while (i-- > 0) if (mask.charCodeAt(value.charCodeAt(i)) !== 49 /* 1 */) return false
  return true
}

function validParamName(name: string): boolean {
  return PARAM_NAME.test(name) && !RESERVED_PARAM_NAMES.has(name)
}

/**
 * Explain WHY a parameter name was rejected, in the terms the author was thinking in.
 *
 * The grammar is per-segment: a segment is wholly static or wholly a parameter, so everything after
 * the colon is the name. `/v/:id.json` therefore asks for a parameter literally named `id.json`,
 * which is not what anyone means by it - but the bare "invalid parameter" that produces reads as a
 * typo rather than as a rule, leaving the author to guess whether the dot, the length, or the casing
 * was the problem. Naming the actual limitation and showing the two ways out is the difference
 * between a five-second fix and a trip to the source.
 */
function paramNameHint(name: string): string {
  if (RESERVED_PARAM_NAMES.has(name)) return ` - "${name}" is reserved (prototype key)`
  if (name.length === 0) return ` - ":" needs a name after it`
  // No "a segment is wholly static or wholly a parameter" case here any more: mixed segments made
  // that message obsolete. `:id.json` was the shape it explained, and `:id.json` now compiles.
  return ` - a name must match ${PARAM_NAME.source}`
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
    // A constraint belongs to the parameter; braces that are not one stay literal text.
    const constraint = paramConstraint(value.slice(paramEnd))
    parts.push({ t: "param", name, c: constraint })
    sawParam = true
    i = paramEnd - 1 + (constraint ? constraint.source.length + 2 : 0)
  }
  if (!sawParam) return undefined
  if (literal !== "") parts.push({ t: "lit", v: literal })
  return parts
}

/**
 * A canonical string for one mixed segment's shape: the anchored-regex source that describes what the
 * segment accepts, with a capture per parameter. Two segments with the same source are the same shape.
 *
 * It is an identity and an ordering key. Matching goes through {@link matchMixedSegment}, which accepts
 * exactly what this source describes without compiling it - for a segment with no constraint. A
 * constrained parameter's capture is its constraint, and there the scanner accepts less than the
 * source describes: it places the literals as if nothing were constrained and then tests each value.
 */
export function mixedSegmentSource(parts: readonly MixedPart[]): string {
  let source = ""
  for (const part of parts) {
    // LAZY (`+?`), not greedy. A greedy capture swallows the trailing literal, so `/:key.txt` against
    // `/abc.txt` would capture `abc.txt` and then fail to match `\.txt`. With `^…$` anchoring, the
    // lazy form still yields `abc.txt` for `/abc.txt.txt` - the anchor forces the LAST `.txt` to be
    // the literal. `+?` and not `*?`: an empty capture must not match (see the empty-segment rule).
    source +=
      part.t === "lit"
        ? escapeRegex(part.v)
        : part.c === undefined
          ? "([^/]+?)"
          : `(${part.c.oneOf?.map(escapeRegex).join("|") ?? part.c.source})`
  }
  return source
}

/**
 * A mixed segment laid out for matching: the literals around its parameters, in order. The first
 * entry is the literal before the first parameter, and each entry after it is the literal following
 * the next parameter, so a segment with N parameters has N + 1 entries. An entry is `""` where the
 * segment has no literal in that position - at either end, or between two parameters that touch.
 *
 * `/v:major.:minor` is `["v", ".", ""]`; `/:name.json` is `["", ".json"]`.
 */
export type MixedSegmentShape = readonly string[]

/** Lay a mixed segment's parts out as a {@link MixedSegmentShape}. Done once, at registration. */
export function mixedSegmentShape(parts: readonly MixedPart[]): MixedSegmentShape {
  // Two literals are never adjacent, so a literal fills the open slot and a parameter opens the next.
  const shape = [""]
  for (const part of parts) {
    if (part.t === "lit") shape[shape.length - 1] = part.v
    else shape.push("")
  }
  return shape
}

/**
 * The parts of a mixed segment when at least one of its parameters has a constraint, else
 * `undefined`. It is the fourth argument to {@link matchMixedSegment}; done once, at registration.
 */
export function constrainedParts(parts: readonly MixedPart[]): readonly MixedPart[] | undefined {
  return parts.some((part) => part.t === "param" && part.c) ? parts : undefined
}

/**
 * Match ONE path segment against a mixed shape, in a single left-to-right pass.
 *
 * On a match the captures are appended to `out` in parameter order and the result is `true`. On a miss
 * `out` is left exactly as it was and the result is `false`.
 *
 * The rule: the leading literal must start the segment and the trailing literal must end it; every
 * parameter takes at least one character; and each literal between two parameters is taken at its
 * FIRST occurrence that leaves the parameter before it non-empty. The last parameter takes what
 * remains. Two parameters with nothing between them give the first one a single character.
 *
 * That is the match an anchored pattern with lazy captures selects, reached without trying the
 * alternatives: taking a literal earlier only ever hands more text to the parameter after it, so if
 * any placement matches, the earliest one does. The work is therefore bounded by the segment's length
 * however many parameters the shape has - a segment is request-controlled and must not be able to buy
 * more than one pass.
 *
 * Constraints are tested last, on the values that rule produced: pass `checked` (from
 * {@link constrainedParts}) and a value that fails its parameter's constraint is a miss. A failed
 * test never moves a literal to a later occurrence to try again, so the cost stays one pass to place
 * the literals and one over the values.
 *
 * `segment` must not contain `/`.
 */
export function matchMixedSegment(
  shape: MixedSegmentShape,
  segment: string,
  out: string[],
  checked?: readonly MixedPart[],
): boolean {
  const last = shape.length - 1
  const head = shape[0]!
  const tail = shape[last]!
  let at = head.length
  const end = segment.length - tail.length
  // The first parameter needs a character between the two end literals. This also refuses end
  // literals that would overlap in the text (`a.:x.b` against `a.b`).
  if (at >= end) return false
  if (at !== 0 && !segment.startsWith(head)) return false
  if (end !== segment.length && !segment.endsWith(tail)) return false
  const base = out.length
  for (let i = 1; i < last; i++) {
    const separator = shape[i]!
    // An empty separator is found right here, which gives the parameter before it one character.
    const found = segment.indexOf(separator, at + 1)
    const next = found + separator.length
    // The parameter after this separator needs a character before the trailing literal. A first
    // occurrence that leaves none means every later one does too.
    if (found === -1 || next >= end) {
      out.length = base
      return false
    }
    out.push(segment.slice(at, found))
    at = next
  }
  out.push(segment.slice(at, end))
  if (checked !== undefined) {
    let value = base
    for (const part of checked) {
      if (part.t === "param" && !satisfies(part.c, out[value++]!)) {
        out.length = base
        return false
      }
    }
  }
  return true
}

/** Whether a segment is `:name?` or `:name{constraint}?` and nothing else. The caller has seen
 * that the pattern ends in `?`; a segment before the last one is tested for it here. */
function isOptionalParam(segment: string): boolean {
  const parts = segment.endsWith("?") ? splitMixed(segment.slice(0, -1)) : undefined
  return parts?.length === 1 && parts[0]!.t === "param"
}

/**
 * The concrete patterns an optional-parameter pattern stands for, shortest first.
 *
 * A path may END in a run of whole-segment optional parameters, `:name?` or, with a constraint,
 * `:name{[0-9]+}?`. It is shorthand for one
 * route per prefix of that run: `/users/:id?` is `/users` and `/users/:id`, and `/a/:b?/:c?` is `/a`,
 * `/a/:b`, and `/a/:b/:c`. A later parameter is only present when every earlier one is, so a run of
 * `n` parameters is `n + 1` patterns, never `2^n`.
 *
 * Every other pattern comes back unchanged as the only element. That includes a `?` anywhere but the
 * trailing run (`/a/:b?/c`) or inside a mixed segment (`/files/:name.:ext?`): there it is literal
 * text, as it always was.
 *
 * Expansion happens before compilation, so each result is an ordinary pattern for
 * {@link compileRoutePattern} and a matcher never learns that a parameter was optional.
 */
export function expandOptionalParams(pattern: string): readonly string[] {
  if (pattern.charCodeAt(pattern.length - 1) !== 63 /* ? */) return [pattern]
  const segments = pattern.split("/")
  let first = segments.length
  while (first > 1 && isOptionalParam(segments[first - 1]!)) first--
  let form = segments.slice(0, first).join("/")
  const forms = [form || "/"]
  for (let i = first; i < segments.length; i++) {
    form += `/${segments[i]!.slice(0, -1)}`
    forms.push(form)
  }
  return forms
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

/**
 * Total ordering for mixed segment shapes, shared by the trie and regex-based routers.
 *
 * Code-unit comparison, never `localeCompare`: this exists so the server and the browser agree on which
 * of two equally-weighted patterns wins, and `localeCompare` answers by the RUNTIME's locale - a server
 * and a visitor in different locales would order the same pair differently, which is the divergence
 * being prevented.
 */
export function compareMixedPartsSpecificity(
  left: readonly MixedPart[],
  right: readonly MixedPart[],
): number {
  const literalWeight = (parts: readonly MixedPart[]): number =>
    parts.reduce((sum, part) => (part.t === "lit" ? sum + part.v.length : sum), 0)
  const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
  const rank = (constraint: ParamConstraint | undefined): number =>
    constraint ? (constraint.oneOf ? 0 : 1) : 2

  const weightDifference = literalWeight(right) - literalWeight(left)
  if (weightDifference !== 0) return weightDifference

  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i++) {
    const a = left[i]
    const b = right[i]
    if (a === undefined || b === undefined) return b === undefined ? -1 : 1
    if (a.t !== b.t) return a.t === "lit" ? -1 : 1
    if (a.t === "lit" && b.t === "lit" && a.v !== b.v) {
      return a.v.length === b.v.length ? order(a.v, b.v) : b.v.length - a.v.length
    }
    if (a.t === "param" && b.t === "param") {
      // A constrained parameter before a free one, a list of values before a class. Two of a kind:
      // the one that accepts less goes first, so a constraint contained in another is tried before
      // it (`\d+` before `\w+`, whichever way each is spelled). The key settles the rest, and the
      // result never depends on registration order.
      const x = a.c
      const y = b.c
      const difference =
        rank(x) - rank(y) ||
        (x && y && (x.size - y.size || x.max - x.min - (y.max - y.min) || order(x.key, y.key)))
      if (difference) return difference
    }
  }

  // Same kinds in the same order with the same literals and constraints: the two are one shape.
  // Parameter names do not enter into what a segment matches, so they do not order it either.
  return 0
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

/**
 * Sort compiled routes most-specific-first - a static segment beats a dynamic one, the order the router
 * resolves a path in. The single home for that precedence: the web router, the mock server, and the
 * editor plugin all order routes through this one comparator, so which file a path resolves to can never
 * diverge between runtime, client, and editor. Sorts in place and returns the same array.
 */
export function sortRoutesBySpecificity<T extends { readonly pattern: CompiledRoutePattern }>(
  routes: T[],
): T[] {
  return routes.sort((left, right) => compareRoutePatternSpecificity(left.pattern, right.pattern))
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
  const matcher = matcherOf(compiled)
  const match = matcher.regex.exec(pathname)
  if (match === null) return { matched: false, reason: "not-found" }
  const params: Record<string, string> = {}
  const names = compiled.paramNames
  // One capture group per dynamic segment, in order. A mixed segment's group is the whole segment,
  // which the scanner splits into that segment's parameters.
  let group = 1
  let name = 0
  let captures: string[] | undefined
  for (let i = 0; i < compiled.segments.length; i++) {
    if (compiled.segments[i]!.kind === "static") continue
    const value = match[group++] ?? ""
    const shape = matcher.shapes[i]
    if (shape === undefined) {
      params[names[name++]!] = value
      continue
    }
    captures ??= []
    captures.length = 0
    if (!matchMixedSegment(shape, value, captures, matcher.checked[i])) {
      return { matched: false, reason: "not-found" }
    }
    for (const capture of captures) params[names[name++]!] = capture
  }
  const decoded = decodeRouteParams(params)
  return decoded === null
    ? { matched: false, reason: "malformed" }
    : { matched: true, params: decoded }
}
