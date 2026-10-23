/**
 * The identity epoch: a value the server rotates whenever a response signs a visitor in or out, so a
 * page kept mounted for one visitor is never shown to the next. Browser-safe and free of module-level
 * state, so a client bundle that never calls it carries none of it.
 */

/** The readable cookie holding the epoch on an `https:` origin. */
export const EPOCH_COOKIE = "__Host-nifra-epoch"
/** The same cookie on local `http:` dev, where a `__Host-` cookie cannot be set. */
export const LOCAL_EPOCH_COOKIE = "nifra-epoch"
/** The channel every tab of an origin hears a sign-in or sign-out on. */
export const IDENTITY_CHANNEL = "nifra-identity-v1"

type Listeners = Set<() => void>

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

/** Run `listener` when this document hears that the visitor changed; returns its removal. */
export function onIdentityChange(listener: () => void): () => void {
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
  for (const listener of [...listenersOf()]) listener()
  if (typeof BroadcastChannel === "undefined") return
  const channel = new BroadcastChannel(IDENTITY_CHANNEL)
  channel.postMessage("changed")
  channel.close()
}
