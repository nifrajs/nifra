/**
 * Bun WebSocket plumbing - the `websocket` dispatcher config `listen()` hands to Bun's serve when
 * the app has WS routes. Lives behind the `@nifrajs/core/ws` subpath (via `ws-hook.ts`) so the base
 * bundle of a no-WebSocket app never ships it; `server.ts` only imports the **types** from here
 * (erased). No `Bun.*` calls here - the runtime seam stays in `server.ts` (see runtime-boundary.test).
 */

import {
  createWebSocketSender,
  type NifraWebSocket,
  type TopicRegistry,
  type WebSocketData,
  type WebSocketHandler,
} from "./websocket.ts"
import type { BunWsHandlers } from "./ws-hook.ts"

/** Per-connection state Bun's `websocket` callbacks read via `ws.data`: the matched handler, the
 * `upgrade()`-seeded user data, and the memoized portable {@link NifraWebSocket} wrapper. */
export interface BunWsData {
  readonly handler: WebSocketHandler
  data: unknown
  nifra?: NifraWebSocket
}

/** Structural view of Bun's `ServerWebSocket` - keeps `Bun.*` types out of the public `.d.ts`
 * (`listen()` casts for the same reason). The real socket satisfies this. */
export interface BunSocket {
  send(data: string | ArrayBufferView | ArrayBuffer, compress?: boolean): number
  close(code?: number, reason?: string): void
  readonly readyState: number
  // Bun's native (uWebSockets) topic pub/sub - used only in native-pubsub mode (no per-socket
  // outbound validation), where `app.publish` routes through the Bun server's `publish`.
  subscribe(topic: string): void
  unsubscribe(topic: string): void
  // readonly: we never reassign `ws.data` wholesale, only mutate its fields (`.nifra`, `.data`).
  readonly data: BunWsData
}

/** Normalize a received binary frame to `Uint8Array` (Bun hands a `Buffer`, already one; an
 * `ArrayBuffer` is wrapped). Text frames stay `string`. */
function toBinaryData(message: ArrayBuffer | Uint8Array): Uint8Array {
  return message instanceof Uint8Array ? message : new Uint8Array(message)
}

/**
 * Wrap a Bun `ServerWebSocket` as the portable {@link NifraWebSocket} handed to WS callbacks.
 *
 * `nativePubsub` selects the topic backend: in native mode `subscribe`/`unsubscribe` go straight to
 * Bun's own (uWebSockets) pub/sub so a broadcast via the Bun server's `publish` reaches this socket
 * with no per-connection JS loop; otherwise they use the runtime-neutral {@link TopicRegistry}. Native
 * mode is used only when no route validates outbound frames, so raw and validated sends are identical.
 */
function wrapBunSocket(
  raw: BunSocket,
  topics: TopicRegistry,
  handler: WebSocketHandler,
  nativePubsub: boolean,
): NifraWebSocket {
  let ws!: NifraWebSocket
  const reportError = (error: unknown): void => reportWsError(error, ws, handler)
  const send = createWebSocketSender(
    (data) => {
      raw.send(data)
    },
    handler.sendSchema,
    handler.validateSend,
    handler.transport,
    reportError,
  )
  ws = {
    send,
    close: (code, reason) => raw.close(code, reason),
    get readyState() {
      return raw.readyState
    },
    subscribe: nativePubsub
      ? (topic) => raw.subscribe(topic)
      : (topic) => topics.subscribe(topic, ws),
    unsubscribe: nativePubsub
      ? (topic) => raw.unsubscribe(topic)
      : (topic) => topics.unsubscribe(topic, ws),
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

/**
 * The shared Bun `websocket` dispatcher config for one app - each connection's `ws.data.handler` is
 * the matched route's handler, set by `server.upgrade`.
 *
 * `nativePubsub` (set by `listen()` when the app has no validated-send route) makes subscriptions use
 * Bun's own pub/sub; there the registry holds nothing and Bun auto-drops native subscriptions on
 * close, so the `unsubscribeAll` sweep is skipped.
 */
export function createBunWsHandlers(topics: TopicRegistry, nativePubsub = false): BunWsHandlers {
  return {
    open: (raw) => {
      const ws = raw as BunSocket
      const nifra = wrapBunSocket(ws, topics, ws.data.handler, nativePubsub)
      ws.data.nifra = nifra
      dispatchWsCallback(() => ws.data.handler.open?.(nifra), nifra, ws.data.handler)
    },
    message: (raw, message) => {
      const ws = raw as BunSocket
      const handler = ws.data.handler
      const nifra = ws.data.nifra ?? wrapBunSocket(ws, topics, handler, nativePubsub)
      const data: WebSocketData = typeof message === "string" ? message : toBinaryData(message)
      // Hottest WS path - dispatch inline rather than through `dispatchWsCallback` so no per-frame
      // closure is allocated. Same contract: a sync throw or async rejection routes to `handler.error`.
      try {
        const result = handler.message?.(nifra, data)
        if (result instanceof Promise)
          result.catch((e: unknown) => reportWsError(e, nifra, handler))
      } catch (error) {
        reportWsError(error, nifra, handler)
      }
    },
    close: (raw, code, reason) => {
      const ws = raw as BunSocket
      const nifra = ws.data.nifra ?? wrapBunSocket(ws, topics, ws.data.handler, nativePubsub)
      // Registry mode: drop topic subscriptions so it never holds a dead socket. Native mode: Bun
      // unsubscribes the socket from every topic on close, so there is nothing to sweep here.
      if (!nativePubsub) topics.unsubscribeAll(nifra)
      dispatchWsCallback(() => ws.data.handler.close?.(nifra, code, reason), nifra, ws.data.handler)
    },
  }
}
