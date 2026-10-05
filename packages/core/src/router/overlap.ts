import {
  type CompiledRoutePattern,
  compileRoutePattern,
  expandOptionalParams,
  type MixedPart,
  type ParamConstraint,
} from "./pattern.ts"

type Token =
  | { readonly kind: "char"; readonly value: string }
  | { readonly kind: "param"; readonly c?: ParamConstraint }
  | { readonly kind: "wildcard" }

interface State {
  readonly index: number
  readonly active?: "param" | "wildcard"
  /**
   * Inside a parameter constrained to a character class: how many characters it has taken. Once the
   * class has no upper bound the count stops at the lower one, where it no longer changes anything.
   */
  readonly taken?: number
  /** Inside a parameter constrained to a list of values: what is left of each value still possible. */
  readonly live?: readonly string[]
}

interface ProductNode {
  readonly left: State
  readonly right: State
  readonly previous?: string
  readonly character?: string
}

/** Hard budget for the offline route-language intersection. Never use this on the request path. */
export const ROUTE_PATTERN_OVERLAP_MAX_STATES = 100_000
const ROUTE_PATTERN_OVERLAP_MAX_LENGTH = 16_384

export class RoutePatternOverlapLimitError extends Error {
  readonly code = "ROUTE_OVERLAP_LIMIT"

  constructor() {
    super("route overlap analysis exceeded its safety budget")
    this.name = "RoutePatternOverlapLimitError"
  }
}

const stateKey = (state: State): string =>
  `${state.index}:${state.active ?? "none"}:${state.taken ?? ""}:${state.live?.join("|") ?? ""}`
const productKey = (left: State, right: State): string => `${stateKey(left)}|${stateKey(right)}`

function pushLiteral(tokens: Token[], value: string): void {
  for (const character of value) tokens.push({ kind: "char", value: character })
}

function pushMixed(tokens: Token[], parts: readonly MixedPart[]): void {
  for (const part of parts) {
    if (part.t === "lit") pushLiteral(tokens, part.v)
    else tokens.push(part.c === undefined ? { kind: "param" } : { kind: "param", c: part.c })
  }
}

function tokensOf(pattern: CompiledRoutePattern): readonly Token[] {
  const tokens: Token[] = [{ kind: "char", value: "/" }]
  pattern.segments.forEach((segment, index) => {
    if (index > 0) tokens.push({ kind: "char", value: "/" })
    if (segment.kind === "static") pushLiteral(tokens, segment.value)
    else if (segment.kind === "param") tokens.push({ kind: "param" })
    else if (segment.kind === "wildcard") tokens.push({ kind: "wildcard" })
    else pushMixed(tokens, segment.parts)
  })
  return tokens
}

function epsilon(state: State, tokens: readonly Token[]): State | undefined {
  if (state.active === undefined) return undefined
  // A constrained parameter ends only where its constraint is met: a whole value from the list, or
  // at least the class's lower bound of characters.
  if (state.live?.includes("") === false) return undefined
  const token = tokens[state.index]
  if (state.taken !== undefined && token?.kind === "param" && state.taken < token.c!.min) {
    return undefined
  }
  return { index: state.index + 1 }
}

function advance(state: State, character: string, tokens: readonly Token[]): State | undefined {
  if (state.active === "wildcard") return state
  const token = tokens[state.index]
  if (token === undefined) return undefined
  if (token.kind === "char") {
    return token.value === character ? { index: state.index + 1 } : undefined
  }
  if (token.kind === "wildcard") return { index: state.index, active: "wildcard" }
  if (character === "/") return undefined
  const constraint = token.c
  if (constraint === undefined) {
    return state.active === "param" ? state : { index: state.index, active: "param" }
  }
  if (constraint.oneOf !== undefined) {
    const live = (state.live ?? constraint.oneOf)
      .filter((value) => value[0] === character)
      .map((value) => value.slice(1))
    return live.length === 0 ? undefined : { index: state.index, active: "param", live }
  }
  const taken = state.taken ?? 0
  const code = character.charCodeAt(0)
  if (taken >= constraint.max || constraint.mask.charCodeAt(code) !== 49 /* 1 */) return undefined
  return {
    index: state.index,
    active: "param",
    taken: constraint.max === Infinity ? Math.min(taken + 1, constraint.min) : taken + 1,
  }
}

/** The exact characters that can advance `state`, or `undefined` when it accepts a character class. */
function exactCharacters(state: State, tokens: readonly Token[]): readonly string[] | undefined {
  if (state.active === "wildcard") return undefined
  const token = tokens[state.index]
  if (token === undefined) return []
  if (token.kind === "char") return [token.value]
  if (token.kind === "wildcard") return undefined
  const values = state.live ?? token.c?.oneOf
  return values === undefined
    ? undefined
    : [...new Set(values.flatMap((value) => (value === "" ? [] : [value[0]!])))]
}

// "a" first, so an unconstrained parameter is still witnessed by the letter it always was.
const CLASS_REPRESENTATIVES = ["a"]
for (let code = 33; code < 127; code++) {
  if (code !== 47 /* / */ && code !== 97 /* a */) {
    CLASS_REPRESENTATIVES.push(String.fromCharCode(code))
  }
}

/**
 * Return the finite representative alphabet for this product state. A global alphabet makes a
 * route containing many literal characters quadratic in the number of states. At each state only
 * the exact characters one side asks for can affect the next state, or - when both sides take a
 * class of characters - one character that both classes hold: where a class leads does not depend on
 * which of its characters was taken. Slash is additionally needed only when both sides are
 * wildcards because it can move through a segment boundary that no parameter may consume.
 */
function transitionCharacters(
  left: State,
  right: State,
  leftTokens: readonly Token[],
  rightTokens: readonly Token[],
): readonly string[] {
  const exact = exactCharacters(left, leftTokens) ?? exactCharacters(right, rightTokens)
  if (exact !== undefined) return exact
  const both = (character: string): boolean =>
    advance(left, character, leftTokens) !== undefined &&
    advance(right, character, rightTokens) !== undefined
  const shared = CLASS_REPRESENTATIVES.find(both)
  const characters = shared === undefined ? [] : [shared]
  if (both("/")) characters.push("/")
  return characters
}

function accepted(state: State, tokens: readonly Token[]): boolean {
  return state.active === undefined && state.index === tokens.length
}

function witnessOf(nodes: ReadonlyMap<string, ProductNode>, key: string): string {
  const characters: string[] = []
  let current = key
  while (true) {
    const node = nodes.get(current)
    if (node === undefined || node.previous === undefined) break
    if (node.character !== undefined) characters.push(node.character)
    current = node.previous
  }
  characters.reverse()
  return characters.join("")
}

/**
 * Return a deterministic path accepted by both patterns, or `undefined` when their path languages are
 * disjoint. A pattern ending in optional params is every concrete path it serves, so `/users/:id?`
 * overlaps `/users` as well as `/users/me`.
 *
 * This is a build/check-time NFA product, never a request-time operation. Route literals are the only
 * input alphabet needed: a literal character is tried verbatim, while `a` is a representative for
 * the unrestricted non-slash character class. No user route text is compiled as a regular expression.
 *
 * A constrained parameter is modelled as its constraint: a value from its list, or a run of its
 * class within its bounds. In a segment that has several parameters the router is stricter than
 * that - it places the literals first and tests the values afterwards - so for such a segment the
 * answer errs towards reporting an overlap that no request can reach, never towards missing one.
 * The state budget is one budget for the whole call, however many concrete paths the two sides have.
 */
export function routePatternOverlap(left: string, right: string): string | undefined {
  if (
    left.length > ROUTE_PATTERN_OVERLAP_MAX_LENGTH ||
    right.length > ROUTE_PATTERN_OVERLAP_MAX_LENGTH
  )
    throw new RoutePatternOverlapLimitError()
  const rights = expandOptionalParams(right).map((form) => tokensOf(compileRoutePattern(form)))
  const budget = { states: ROUTE_PATTERN_OVERLAP_MAX_STATES }
  for (const form of expandOptionalParams(left)) {
    const leftTokens = tokensOf(compileRoutePattern(form))
    for (const rightTokens of rights) {
      const witness = tokenOverlap(leftTokens, rightTokens, budget)
      if (witness !== undefined) return witness
    }
  }
  return undefined
}

function tokenOverlap(
  leftTokens: readonly Token[],
  rightTokens: readonly Token[],
  budget: { states: number },
): string | undefined {
  const startLeft: State = { index: 0 }
  const startRight: State = { index: 0 }
  const start = productKey(startLeft, startRight)
  if (budget.states-- <= 0) throw new RoutePatternOverlapLimitError()
  const nodes = new Map<string, ProductNode>([[start, { left: startLeft, right: startRight }]])
  const queue: string[] = [start]
  let head = 0

  const enqueue = (next: string, node: ProductNode): void => {
    if (nodes.has(next)) return
    if (budget.states-- <= 0) throw new RoutePatternOverlapLimitError()
    nodes.set(next, node)
    queue.push(next)
  }

  while (head < queue.length) {
    const key = queue[head++]!
    const node = nodes.get(key)!
    if (accepted(node.left, leftTokens) && accepted(node.right, rightTokens)) {
      return witnessOf(nodes, key)
    }

    const transitions: Array<{ readonly left: State; readonly right: State }> = []
    const leftEpsilon = epsilon(node.left, leftTokens)
    const rightEpsilon = epsilon(node.right, rightTokens)
    if (leftEpsilon !== undefined) transitions.push({ left: leftEpsilon, right: node.right })
    if (rightEpsilon !== undefined) transitions.push({ left: node.left, right: rightEpsilon })

    for (const transition of transitions) {
      const next = productKey(transition.left, transition.right)
      enqueue(next, { ...transition, previous: key })
    }

    for (const character of transitionCharacters(node.left, node.right, leftTokens, rightTokens)) {
      const nextLeft = advance(node.left, character, leftTokens)
      const nextRight = advance(node.right, character, rightTokens)
      if (nextLeft === undefined || nextRight === undefined) continue
      const next = productKey(nextLeft, nextRight)
      enqueue(next, { left: nextLeft, right: nextRight, previous: key, character })
    }
  }

  return undefined
}
