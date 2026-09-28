import { type CompiledRoutePattern, compileRoutePattern, type MixedPart } from "./pattern.ts"

type Token =
  | { readonly kind: "char"; readonly value: string }
  | { readonly kind: "param" }
  | { readonly kind: "wildcard" }

interface State {
  readonly index: number
  readonly active?: "param" | "wildcard"
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

const stateKey = (state: State): string => `${state.index}:${state.active ?? "none"}`
const productKey = (left: State, right: State): string => `${stateKey(left)}|${stateKey(right)}`

function pushLiteral(tokens: Token[], value: string): void {
  for (const character of value) tokens.push({ kind: "char", value: character })
}

function pushMixed(tokens: Token[], parts: readonly MixedPart[]): void {
  for (const part of parts) {
    if (part.t === "lit") pushLiteral(tokens, part.v)
    else tokens.push({ kind: "param" })
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

function epsilon(state: State): State | undefined {
  return state.active === undefined ? undefined : { index: state.index + 1 }
}

function advance(state: State, character: string, tokens: readonly Token[]): State | undefined {
  if (state.active === "param") {
    return character === "/" ? undefined : state
  }
  if (state.active === "wildcard") return state
  const token = tokens[state.index]
  if (token === undefined) return undefined
  if (token.kind === "char") {
    return token.value === character ? { index: state.index + 1 } : undefined
  }
  if (token.kind === "param") {
    return character === "/" ? undefined : { index: state.index, active: "param" }
  }
  return { index: state.index, active: "wildcard" }
}

function stepKind(state: State, tokens: readonly Token[]): Token["kind"] | undefined {
  if (state.active !== undefined) return state.active
  return tokens[state.index]?.kind
}

function literalAt(state: State, tokens: readonly Token[]): string | undefined {
  if (state.active !== undefined) return undefined
  const token = tokens[state.index]
  return token?.kind === "char" ? token.value : undefined
}

/**
 * Return the finite representative alphabet for this product state. A global alphabet makes a
 * route containing many literal characters quadratic in the number of states. At each state only
 * the exact literal characters and the two equivalence classes (non-slash / any character) can
 * affect the next state, so at most two representatives plus one exact character are needed.
 */
function transitionCharacters(
  left: State,
  right: State,
  leftTokens: readonly Token[],
  rightTokens: readonly Token[],
): readonly string[] {
  const leftKind = stepKind(left, leftTokens)
  const rightKind = stepKind(right, rightTokens)
  if (leftKind === undefined || rightKind === undefined) return []

  if (leftKind === "char" && rightKind === "char") {
    const leftValue = literalAt(left, leftTokens)
    const rightValue = literalAt(right, rightTokens)
    return leftValue !== undefined && leftValue === rightValue ? [leftValue] : []
  }

  if (leftKind === "char") {
    const value = literalAt(left, leftTokens)
    if (value === undefined) return []
    return rightKind === "wildcard" || (rightKind === "param" && value !== "/") ? [value] : []
  }
  if (rightKind === "char") {
    const value = literalAt(right, rightTokens)
    if (value === undefined) return []
    return leftKind === "wildcard" || (leftKind === "param" && value !== "/") ? [value] : []
  }

  // Both sides accept a class of characters. "a" represents every non-slash character; slash is
  // additionally needed only when both sides are wildcards because it can move through a segment
  // boundary that no parameter may consume.
  return leftKind === "wildcard" && rightKind === "wildcard" ? ["a", "/"] : ["a"]
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
 * Return a deterministic path accepted by both compiled patterns, or `undefined` when their path
 * languages are disjoint.
 *
 * This is a build/check-time NFA product, never a request-time operation. Route literals are the only
 * input alphabet needed: a literal character is tried verbatim, while `a` is a representative for
 * the unrestricted non-slash character class. No user route text is compiled as a regular expression.
 */
export function routePatternOverlap(left: string, right: string): string | undefined {
  if (
    left.length > ROUTE_PATTERN_OVERLAP_MAX_LENGTH ||
    right.length > ROUTE_PATTERN_OVERLAP_MAX_LENGTH
  )
    throw new RoutePatternOverlapLimitError()
  const leftTokens = tokensOf(compileRoutePattern(left))
  const rightTokens = tokensOf(compileRoutePattern(right))
  const startLeft: State = { index: 0 }
  const startRight: State = { index: 0 }
  const start = productKey(startLeft, startRight)
  const nodes = new Map<string, ProductNode>([[start, { left: startLeft, right: startRight }]])
  const queue: string[] = [start]
  let head = 0

  const enqueue = (next: string, node: ProductNode): void => {
    if (nodes.has(next)) return
    if (nodes.size >= ROUTE_PATTERN_OVERLAP_MAX_STATES) throw new RoutePatternOverlapLimitError()
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
    const leftEpsilon = epsilon(node.left)
    const rightEpsilon = epsilon(node.right)
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
