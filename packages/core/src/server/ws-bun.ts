/**
 * Bun WebSocket plumbing — the `websocket` dispatcher config `listen()` hands to Bun's serve when
 * the app has WS routes. Lives behind the `@nifrajs/core/ws` subpath (via `ws-hook.ts`) so the base
 * bundle of a no-WebSocket app never ships it; `server.ts` only imports the **types** from here
 * (erased). No `Bun.*` calls here — the runtime seam stays in `server.ts` (see runtime-boundary.test).
 */

import type { NifraWebSocket, TopicRegistry, WebSocketData, WebSocketHandler } from "./websocket.ts"
import type { BunWsHandlers } from "./ws-hook.ts"

/** Per-connection state Bun's `websocket` callbacks read via `ws.data`: the matched handler, the
 * `upgrade()`-seeded user data, and the memoized portable {@link NifraWebSocket} wrapper. */
export interface BunWsData {
  readonly handler: WebSocketHandler
  data: unknown
  nifra?: NifraWebSocket
}

/** Structural view of Bun's `ServerWebSocket` — keeps `Bun.*` types out of the public `.d.ts`
 * (`listen()` casts for the same reason). The real socket satisfies this. */
export interface BunSocket {
  send(data: string | ArrayBufferView | ArrayBuffer, compress?: boolean): number
  close(code?: number, reason?: string): void
  readonly readyState: number
  // readonly: we never reassign `ws.data` wholesale, only mutate its fields (`.nifra`, `.data`).
  readonly data: BunWsData
}

/** Normalize a received binary frame to `Uint8Array` (Bun hands a `Buffer`, already one; an
 * `ArrayBuffer` is wrapped). Text frames stay `string`. */
function toBinaryData(message: ArrayBuffer | Uint8Array): Uint8Array {
  return message instanceof Uint8Array ? message : new Uint8Array(message)
}

/** Wrap a Bun `ServerWebSocket` as the portable {@link NifraWebSocket} handed to WS callbacks. */
function wrapBunSocket(raw: BunSocket, topics: TopicRegistry): NifraWebSocket {
  const ws: NifraWebSocket = {
    send: (data) => {
      raw.send(data)
    },
    close: (code, reason) => raw.close(code, reason),
    get readyState() {
      return raw.readyState
    },
    subscribe: (topic) => topics.subscribe(topic, ws),
    unsubscribe: (topic) => topics.unsubscribe(topic, ws),
    get data() {
      return raw.data.data
    },
    set data(value) {
      raw.data.data = value
    },
    raw,
  }
  return ws
}

function reportWsError(error: unknown, ws: NifraWebSocket, handler: WebSocketHandler): void {
  if (handler.error === undefined) return
  try {
    const result = handler.error(ws, error)
    if (result instanceof Promise) result.catch(() => {}) // a throwing error handler is the last resort
  } catch {
    /* swallow: the error handler itself failed; nothing left to do but not crash */
  }
}

/** Run a WS lifecycle callback, routing a sync throw or async rejection to `handler.error` so a
 * failing callback never crashes the socket loop. */
function dispatchWsCallback(
  call: () => void | Promise<void>,
  ws: NifraWebSocket,
  handler: WebSocketHandler,
): void {
  try {
    const result = call()
    if (result instanceof Promise) result.catch((e: unknown) => reportWsError(e, ws, handler))
  } catch (error) {
    reportWsError(error, ws, handler)
  }
}

/** The shared Bun `websocket` dispatcher config for one app — each connection's
 * `ws.data.handler` is the matched route's handler, set by `server.upgrade`. */
export function createBunWsHandlers(topics: TopicRegistry): BunWsHandlers {
  return {
    open: (raw) => {
      const ws = raw as BunSocket
      const nifra = wrapBunSocket(ws, topics)
      ws.data.nifra = nifra
      dispatchWsCallback(() => ws.data.handler.open?.(nifra), nifra, ws.data.handler)
    },
    message: (raw, message) => {
      const ws = raw as BunSocket
      const nifra = ws.data.nifra ?? wrapBunSocket(ws, topics)
      const data: WebSocketData = typeof message === "string" ? message : toBinaryData(message)
      dispatchWsCallback(() => ws.data.handler.message?.(nifra, data), nifra, ws.data.handler)
    },
    close: (raw, code, reason) => {
      const ws = raw as BunSocket
      const nifra = ws.data.nifra ?? wrapBunSocket(ws, topics)
      topics.unsubscribeAll(nifra) // drop topic subscriptions so the registry never holds a dead socket
      dispatchWsCallback(() => ws.data.handler.close?.(nifra, code, reason), nifra, ws.data.handler)
    },
  }
}
