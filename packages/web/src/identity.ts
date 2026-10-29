/**
 * The identity epoch: a value the server rotates whenever a response signs a visitor in or out, so a
 * page kept mounted for one visitor is never shown to the next. Browser-safe; its one module-level
 * value, the epoch {@link documentEpoch} read, goes with that function from a bundle that never calls it.
 */

/** The readable cookie holding the epoch on an `https:` origin. */
export const EPOCH_COOKIE = "__Host-nifra-epoch"
/** The same cookie on local `http:` dev, where a `__Host-` cookie cannot be set. */
export const LOCAL_EPOCH_COOKIE = "nifra-epoch"
/** The channel every tab of an origin hears a sign-in or sign-out on. */
export const IDENTITY_CHANNEL = "nifra-identity-v1"

type Listeners = Set<() => void>
const CHANNEL = Symbol.for("nifra.identity.channel")

// Looked up per call: a module-level `Symbol.for` would be code every client bundle keeps.
const listenersOf = (): Listeners => {
  const key = Symbol.for("nifra.identity.listeners")
  let listeners: unknown = Reflect.get(globalThis, key)
  if (!(listeners instanceof Set)) {
    listeners = new Set<() => void>()
    Reflect.set(globalThis, key, listeners)
  }
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: only this module writes the slot, always a set of listeners
  return listeners as Listeners
}

const dispatchIdentityChange = (): void => {
  const errors: unknown[] = []
  for (const listener of [...listenersOf()]) {
    try {
      listener()
    } catch (error) {
      errors.push(error)
    }
  }
  // A broken observer must not prevent the other caches and mutations from crossing the boundary.
  // Surface failures asynchronously after every cleanup observer has had its turn.
  if (errors.length > 0)
    queueMicrotask(() => {
      throw new AggregateError(errors, "[nifra/web] identity-change cleanup failed")
    })
}

const identityChannel = (): BroadcastChannel | undefined => {
  if (typeof (globalThis as { window?: unknown }).window === "undefined") return undefined
  const existing: unknown = Reflect.get(globalThis, CHANNEL)
  if (
    typeof existing === "object" &&
    existing !== null &&
    typeof Reflect.get(existing, "postMessage") === "function"
  )
    return existing as BroadcastChannel
  if (typeof BroadcastChannel === "undefined") return undefined

  let channel: BroadcastChannel | undefined
  try {
    channel = new BroadcastChannel(IDENTITY_CHANNEL)
    channel.addEventListener("message", (event) => {
      // Messages are untrusted input. Only the framework's fixed identity signal may invalidate state.
      if (event.data === "changed") dispatchIdentityChange()
    })
    // Node and Bun expose `unref`; a page's persistent receiver must not keep a test/process alive.
    const unref = Reflect.get(channel, "unref")
    if (typeof unref === "function") Reflect.apply(unref, channel, [])
    Reflect.set(globalThis, CHANNEL, channel)
    return channel
  } catch {
    // BroadcastChannel can be blocked by browser policy; keep same-tab invalidation functional.
    try {
      channel?.close()
    } catch {
      // Closing a partially initialized channel is best effort too.
    }
    return undefined
  }
}

/** The epoch in a `document.cookie` string, or `""` when it carries none. */
export function epochOf(cookie: string): string {
  let local = ""
  for (const part of cookie.split(";")) {
    const at = part.indexOf("=")
    if (at === -1) continue
    const name = part.slice(0, at).trim()
    if (name === EPOCH_COOKIE) return part.slice(at + 1).trim()
    if (name === LOCAL_EPOCH_COOKIE) local = part.slice(at + 1).trim()
  }
  return local
}

// Read once per synchronous run: `document.cookie` costs microseconds a read, and a cookie a response
// sets lands in a later task, never partway through a run.
let runEpoch: string | undefined

/** The epoch in this document's cookies, or `""` with no document or none set. */
export function documentEpoch(): string {
  if (runEpoch !== undefined) return runEpoch
  // Read without the DOM types: its callers also build in tsconfigs that leave the DOM lib out.
  const cookie: unknown = Reflect.get(Reflect.get(globalThis, "document") ?? {}, "cookie")
  const epoch = typeof cookie === "string" ? epochOf(cookie) : ""
  runEpoch = epoch
  queueMicrotask(() => {
    runEpoch = undefined
  })
  return epoch
}

/** Run `listener` when this document hears that the visitor changed; returns its removal. */
export function onIdentityChange(listener: () => void): () => void {
  identityChannel()
  const listeners = listenersOf()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Tell this tab and every other tab of the origin that the visitor signed in or out. Call it at login
 * and logout when identity lives in client storage (a bearer token) rather than in a cookie, which the
 * server's epoch cookie already covers: every page kept alive for the previous visitor is dropped.
 */
export function identityChanged(): void {
  dispatchIdentityChange()
  identityChannel()?.postMessage("changed")
}
