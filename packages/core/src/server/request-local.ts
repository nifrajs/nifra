/**
 * Request-local state: a value tied to one request that follows it through the copies made of it.
 * A `WeakMap<Request, T>` loses its value at the first `new Request(url, req)`, and nifra itself
 * rebuilds a request when a mount strips its prefix, when a WebSocket pass is reused for HTTP, and
 * when a target is resolved. Every such copy joins the request's scope, so each reads and writes
 * the same values.
 */

/** One request-local slot from {@link requestLocal}. */
export interface RequestLocal<T> {
  /** The value set through `request` or any request in its scope, else `undefined`. */
  get(request: Request): T | undefined
  /** Set the value for `request`'s whole scope. */
  set(request: Request, value: T): void
  has(request: Request): boolean
  /** Remove the value from `request`'s scope; `true` when there was one. */
  delete(request: Request): boolean
}

type Values = Map<object, unknown>

/**
 * A copy maps to the request it was made from, and the end of that chain (the anchor) to its
 * scope's values once one is set. Keyed in the global symbol registry so two copies of core keep
 * one table, and weak, so a scope lives exactly as long as a request in it.
 */
type Links = WeakMap<Request, Request | Values>

// biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion lint/plugin/noChainedTypeAssertions: only this module writes the slot, and only a Links table.
const shared = globalThis as unknown as Record<symbol, Links | undefined>
const LINKS = Symbol.for("nifra.requestLocals")

const linksOf = (): Links => (shared[LINKS] ??= new WeakMap())

/** The request at the end of `request`'s chain of copies. */
function anchorOf(links: Links, request: Request): Request {
  let anchor = request
  let link = links.get(anchor)
  while (link !== undefined && !(link instanceof Map)) {
    anchor = link
    link = links.get(anchor)
  }
  return anchor
}

/** `to` was just built from `from`, with nothing set on it: it joins `from`'s scope. Until a first
 * slot makes the table there is no scope to join, and a copy records nothing. */
export function carryToCopy(from: Request, to: Request): void {
  shared[LINKS]?.set(to, from)
}

/**
 * Join `to` to `from`'s request-local scope: each then reads every value set through either, now
 * and later. nifra does this wherever it rebuilds a request itself; call it where a wrapper or an
 * `onRequest` hook rebuilds one, right after `new Request(url, req)`. A value `to` already holds is
 * kept where `from` has none.
 */
export function carryRequestLocals(from: Request, to: Request): void {
  const links = shared[LINKS]
  if (links === undefined) return
  const target = anchorOf(links, from)
  const joining = anchorOf(links, to)
  if (target === joining) return
  const own = links.get(joining)
  links.set(joining, target)
  if (!(own instanceof Map)) return
  const held = links.get(target)
  if (!(held instanceof Map)) links.set(target, own)
  else for (const [key, value] of own) if (!held.has(key)) held.set(key, value)
}

function valuesOf(request: Request, create: boolean): Values | undefined {
  const links = linksOf()
  const anchor = anchorOf(links, request)
  const held = links.get(anchor)
  if (held instanceof Map || !create) return held instanceof Map ? held : undefined
  const fresh: Values = new Map()
  links.set(anchor, fresh)
  return fresh
}

/**
 * A slot for one per-request value - a verified client IP, a request id, an auth decision - that
 * survives the request copies nifra makes (a mount's prefix strip, a WebSocket pass reused for HTTP,
 * target resolution) and the ones a wrapper makes with {@link carryRequestLocals}. A copy made any
 * other way starts empty. Values are held weakly and never cross requests. Make slots at startup, as
 * below: copies are linked only once a first slot exists, so a request copied before then starts
 * empty.
 *
 * ```ts
 * const clientIp = requestLocal<string>()
 * app.onRequest((req, platform) => { clientIp.set(req, platform?.clientIp ?? "") })
 * // ... in a mounted child app, after the prefix strip:
 * clientIp.get(c.req)
 * ```
 */
export function requestLocal<T>(): RequestLocal<T> {
  linksOf()
  const key = {}
  return {
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: only `set` below writes `key`, and only a T.
    get: (request) => valuesOf(request, false)?.get(key) as T | undefined,
    set: (request, value) => {
      valuesOf(request, true)?.set(key, value)
    },
    has: (request) => valuesOf(request, false)?.has(key) === true,
    delete: (request) => valuesOf(request, false)?.delete(key) === true,
  }
}
