import { RouteConfigError } from "../errors.ts"
import { type CompiledRoutePattern, compileRoutePattern } from "./pattern.ts"

/** HTTP methods the router accepts. */
export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const

export type Method = (typeof METHODS)[number]

const METHOD_SET: ReadonlySet<string> = new Set(METHODS)

function isMethod(value: string): value is Method {
  return METHOD_SET.has(value)
}

const SLASH = 47
export const EMPTY_PARAMS: Record<string, string> = Object.freeze({})
const DYNAMIC_MATCH_CACHE_MAX = 2048

/**
 * Result of {@link Router.find}. The `found: false` cases deliberately separate
 * a missing path (404) from a path that exists for other methods (405), so the
 * server layer can answer correctly and populate an `Allow` header.
 */
export type RouterMatch<T> =
  | { readonly found: true; readonly payload: T; readonly params: Record<string, string> }
  | { readonly found: false; readonly reason: "not-found" }
  | { readonly found: false; readonly reason: "method-not-allowed"; readonly allowed: string[] }

/**
 * Payload at a terminal node: per-method handlers plus the ordered param names
 * for this path shape. Bundling them means "a node that has handlers always has
 * param names" is enforced by the type, not by a runtime invariant — which
 * removes the otherwise-dead defensive branches in `find`.
 */
interface Terminal<T> {
  readonly handlers: Map<string, T>
  readonly paramNames: readonly string[]
  readonly staticMatches?: Map<string, RouterMatch<T>>
}

interface DynamicMatchCacheEntry<T> {
  readonly terminal: Terminal<T>
  readonly values: readonly string[]
}

interface DynamicMatchCacheState<T> {
  cache: Map<string, DynamicMatchCacheEntry<T>> | undefined
  pendingPath: string | undefined
}

const DYNAMIC_MATCH_CACHES = new WeakMap<object, DynamicMatchCacheState<unknown>>()

function dynamicMatchCacheStateFor<T>(owner: object): DynamicMatchCacheState<T> {
  const existing = DYNAMIC_MATCH_CACHES.get(owner)
  if (existing !== undefined) {
    return existing as DynamicMatchCacheState<T>
  }
  const state: DynamicMatchCacheState<T> = {
    cache: undefined,
    pendingPath: undefined,
  }
  DYNAMIC_MATCH_CACHES.set(owner, state as DynamicMatchCacheState<unknown>)
  return state
}

interface RouteNode<T> {
  /** Exact-segment children keyed by literal segment. */
  readonly staticChildren: Map<string, RouteNode<T>>
  /** Single `:param` child, if any. */
  paramChild: RouteNode<T> | undefined
  /** Catch-all `*` child, if any — always terminal. */
  wildcardChild: RouteNode<T> | undefined
  /** Set once this node terminates one or more routes. */
  terminal: Terminal<T> | undefined
}

function createNode<T>(): RouteNode<T> {
  return {
    staticChildren: new Map(),
    paramChild: undefined,
    wildcardChild: undefined,
    terminal: undefined,
  }
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Depth-first match with backtracking, walking the path by character offsets
 * instead of pre-splitting it into an array. `start` is the index of the first
 * char of the current segment; the segment runs to the next `/` (or end). Tries
 * static, then param, then wildcard; if a static branch dead-ends, param/wildcard
 * are still attempted — so `/a/b/c` and `/a/:x/d` coexist and `/a/b/d` resolves
 * to the param route. Fills `paramValues` along the successful path; abandoned
 * branches are popped. Avoiding the split keeps `find` allocation-light: only the
 * segment substrings needed for map lookups (and matched param values) are cut.
 */
function matchNode<T>(
  node: RouteNode<T>,
  path: string,
  start: number,
  len: number,
  paramValues: string[],
): Terminal<T> | undefined {
  const slash = path.indexOf("/", start)
  const isLast = slash === -1
  const end = isLast ? len : slash
  const seg = path.slice(start, end)

  const staticChild = node.staticChildren.get(seg)
  if (staticChild !== undefined) {
    if (isLast) {
      if (staticChild.terminal !== undefined) return staticChild.terminal
    } else {
      const found = matchNode(staticChild, path, end + 1, len, paramValues)
      if (found !== undefined) return found
    }
  }

  const paramChild = node.paramChild
  // An empty segment (`/users//posts`) never matches a `:param` — matching would hand the handler
  // `id: ""` and downstream code a `WHERE id = ''` class of bug. Peers (Hono, Elysia, Next) 404
  // here too; a static "" child can still match (none is ever registered — INVALID_PATH guards).
  if (paramChild !== undefined && seg.length > 0) {
    paramValues.push(seg)
    if (isLast) {
      if (paramChild.terminal !== undefined) return paramChild.terminal
    } else {
      const found = matchNode(paramChild, path, end + 1, len, paramValues)
      if (found !== undefined) return found
    }
    paramValues.pop() // backtrack: this branch failed deeper down
  }

  const wildcard = node.wildcardChild
  if (wildcard !== undefined && wildcard.terminal !== undefined) {
    // Capture the rest of the path verbatim from this segment's start.
    paramValues.push(path.slice(start))
    return wildcard.terminal
  }

  return undefined
}

function buildParams(names: readonly string[], values: readonly string[]): Record<string, string> {
  if (names.length === 0) return EMPTY_PARAMS
  const params: Record<string, string> = {}
  for (let i = 0; i < names.length; i++) {
    // names and values align: one value was pushed per param/wildcard node along
    // the matched path, in declaration order.
    params[names[i]!] = values[i]!
  }
  return params
}

function resolve<T>(
  terminal: Terminal<T>,
  method: string,
  params: Record<string, string>,
): RouterMatch<T> {
  if (terminal.staticMatches !== undefined && params === EMPTY_PARAMS) {
    const upper = method.toUpperCase()
    const cached = terminal.staticMatches.get(upper)
    if (cached !== undefined) return cached
    if (!terminal.handlers.has(upper)) return resolveDirect(terminal, method, params)

    const res = resolveDirect(terminal, method, params)
    terminal.staticMatches.set(upper, res)
    return res
  }
  return resolveDirect(terminal, method, params)
}

function resolveDirect<T>(
  terminal: Terminal<T>,
  method: string,
  params: Record<string, string>,
): RouterMatch<T> {
  if (terminal.handlers.has(method)) {
    return { found: true, payload: terminal.handlers.get(method)!, params }
  }
  const upper = method.toUpperCase()
  if (upper === method || !terminal.handlers.has(upper)) {
    return { found: false, reason: "method-not-allowed", allowed: [...terminal.handlers.keys()] }
  }
  const payload = terminal.handlers.get(upper)! // present by the has() check above
  return { found: true, payload, params }
}

/**
 * Radix-style segment trie router. Matching precedence is static > param >
 * wildcard. Parameter/wildcard values are returned RAW (not percent-decoded);
 * the server boundary decodes and rejects malformed encodings with a 400,
 * keeping this layer pure and allocation-light.
 *
 * @typeParam T - the payload stored per (method, path); a route descriptor in
 * practice, but the router is agnostic to it.
 */
export class Router<T> {
  private readonly root: RouteNode<T>
  /**
   * Fast path: fully-static paths (no `:param`/`*`) resolve in a single map
   * lookup keyed by the full path, skipping the trie walk entirely. Values are
   * the same `Terminal` objects held in the trie, so adding a method later
   * updates both views at once.
   */
  private readonly staticRoutes: Map<string, Terminal<T>>
  /**
   * Scratch storage for param/wildcard captures during a synchronous trie walk. `find()` copies the
   * values into the returned params object before clearing this array, so returned matches never share
   * mutable state. Kept per Router instance, not module-global, to avoid cross-app coupling.
   */
  private readonly paramValuesScratch: string[]

  constructor() {
    this.root = createNode<T>()
    this.staticRoutes = new Map()
    this.paramValuesScratch = []
  }

  /**
   * Register a payload for `method` + `path`. Throws {@link RouteConfigError}
   * (boot-time, L2) on a duplicate route, a malformed pattern, or conflicting
   * parameter names for the same path shape.
   */
  add(method: Method, pattern: string | CompiledRoutePattern, payload: T): void {
    DYNAMIC_MATCH_CACHES.delete(this)
    const upper = method.toUpperCase()
    // The `Method` parameter type is the compile-time guard; this re-checks at
    // runtime for JS callers and dynamically-computed methods.
    if (!isMethod(upper)) {
      throw new RouteConfigError("INVALID_METHOD", `unsupported HTTP method "${method}"`)
    }
    const compiled = typeof pattern === "string" ? compileRoutePattern(pattern) : pattern
    const path = compiled.pattern
    const paramNames = compiled.paramNames
    const isStatic = paramNames.length === 0
    let node = this.root

    for (const segment of compiled.segments) {
      if (segment.kind === "param") {
        node.paramChild ??= createNode<T>()
        node = node.paramChild
      } else if (segment.kind === "wildcard") {
        node.wildcardChild ??= createNode<T>()
        node = node.wildcardChild
      } else {
        let child = node.staticChildren.get(segment.value)
        if (child === undefined) {
          child = createNode<T>()
          node.staticChildren.set(segment.value, child)
        }
        node = child
      }
    }

    const existing = node.terminal
    let terminal: Terminal<T>
    if (existing !== undefined) {
      if (!sameNames(existing.paramNames, paramNames)) {
        throw new RouteConfigError(
          "PARAM_NAME_CONFLICT",
          `conflicting parameter names for "${path}": [${existing.paramNames.join(", ")}] vs [${paramNames.join(", ")}]`,
        )
      }
      if (existing.handlers.has(upper)) {
        throw new RouteConfigError("DUPLICATE_ROUTE", `duplicate route: ${upper} ${path}`)
      }
      existing.handlers.set(upper, payload)
      existing.staticMatches?.clear()
      terminal = existing
    } else {
      terminal = isStatic
        ? {
            handlers: new Map([[upper, payload]]),
            paramNames,
            staticMatches: new Map(),
          }
        : {
            handlers: new Map([[upper, payload]]),
            paramNames,
          }
      node.terminal = terminal
    }

    // Mirror fully-static routes into the fast-path map (same Terminal object).
    if (isStatic) {
      this.staticRoutes.set(path, terminal)
    }
  }

  /**
   * Resolve `method` + `path`. Tolerant of a missing leading slash and of
   * method casing. Never throws.
   */
  find(method: string, path: string): RouterMatch<T> {
    const len = path.length
    const leading = len > 0 && path.charCodeAt(0) === SLASH

    // Fast path: a fully-static path resolves in one map lookup, no trie walk.
    if (leading) {
      const staticTerminal = this.staticRoutes.get(path)
      if (staticTerminal !== undefined) {
        return resolve(staticTerminal, method, EMPTY_PARAMS)
      }
    }

    return this.findDynamic(method, path, leading, len)
  }

  private findDynamic(method: string, path: string, leading: boolean, len: number): RouterMatch<T> {
    if (leading) {
      const cached = (
        DYNAMIC_MATCH_CACHES.get(this) as DynamicMatchCacheState<T> | undefined
      )?.cache?.get(path)
      if (cached !== undefined) {
        return resolve(
          cached.terminal,
          method,
          buildParams(cached.terminal.paramNames, cached.values),
        )
      }
    }

    const paramValues = this.paramValuesScratch
    paramValues.length = 0
    try {
      const terminal = matchNode(this.root, path, leading ? 1 : 0, len, paramValues)
      if (terminal === undefined) {
        return { found: false, reason: "not-found" }
      }
      if (leading && terminal.paramNames.length > 0) {
        this.maybeCacheDynamicMatch(path, terminal, paramValues)
      }
      return resolve(terminal, method, buildParams(terminal.paramNames, paramValues))
    } finally {
      paramValues.length = 0
    }
  }

  private maybeCacheDynamicMatch(
    path: string,
    terminal: Terminal<T>,
    values: readonly string[],
  ): void {
    const state = dynamicMatchCacheStateFor<T>(this)
    if (state.pendingPath !== path) {
      state.pendingPath = path
      return
    }
    let cache = state.cache
    if (cache === undefined) {
      cache = new Map<string, DynamicMatchCacheEntry<T>>()
      state.cache = cache
    }
    if (cache.size >= DYNAMIC_MATCH_CACHE_MAX) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(path, {
      terminal,
      values: values.slice(0, terminal.paramNames.length),
    })
  }
}
