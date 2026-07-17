/**
 * WebSocket runtime contract. `server.ts` type-imports only this; the `.use(websocket())` plugin
 * (from `@nifrajs/core/ws`) installs the implementation on a server instance via the `INSTALL_WS`
 * symbol seam. That keeps the WS dispatcher, pub/sub registry, Bun socket plumbing, and
 * message-schema validation out of the base server bundle for apps that never call `app.ws()`
 * (~1.5 KB gzipped on the minimal-app benchmark).
 *
 * Only type declarations below - this module must stay weightless, it is always in the base bundle.
 */

import type {
  NifraWebSocket,
  StandardWebSocket,
  TopicRegistry,
  WebSocketHandler,
} from "./websocket.ts"

/** The Bun serve `websocket` callback trio, closed over one app's `TopicRegistry`. The `ws`
 * params are `unknown` so `Bun.*` types never leak into the public `.d.ts`; the implementation
 * narrows to its structural `BunSocket` view. */
export interface BunWsHandlers {
  open(ws: unknown): void
  message(ws: unknown, message: string | ArrayBuffer | Uint8Array): void
  close(ws: unknown, code: number, reason: string): void
}

/** What `@nifrajs/core/ws` registers: everything `server.ts` and `toFetchHandler` need at runtime. */
export interface WsRuntime {
  /** `wrapWebSocketMessageValidation` - applied once at `app.ws()` registration. */
  wrapHandler(handler: WebSocketHandler): WebSocketHandler
  /** One in-process pub/sub registry per app (backs `ws.subscribe` + `app.publish`). */
  createTopics(): TopicRegistry
  /** The Bun `websocket` config for `listen()` when the app has WS routes. */
  bunHandlers(topics: TopicRegistry): BunWsHandlers
  /** `attachWebSocket` - wires a standard server socket (Workers `WebSocketPair`) to a handler. */
  attach(
    socket: StandardWebSocket,
    handler: WebSocketHandler,
    data: unknown,
    options: { openNow: boolean; pubsub: TopicRegistry },
  ): NifraWebSocket
}
