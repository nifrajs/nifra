/**
 * WebSocket runtime for `@nifrajs/core` — import once at your server entry to enable `app.ws()`:
 *
 *   import "@nifrajs/core/ws"
 *
 *   const app = server().ws("/chat", { message: (ws, data) => ws.send(data) })
 *
 * Why a subpath: an app that never uses WebSockets shouldn't ship the WS dispatcher, pub/sub
 * registry, and Bun socket plumbing in its server bundle (~1.5 KB gzipped on the minimal-app size
 * benchmark). Importing this module registers the runtime with the core server (idempotent);
 * calling `app.ws()` without it fails loud at boot with a `WS_RUNTIME_MISSING` error pointing here.
 *
 * Serving adapters that wire standard sockets themselves (`@nifrajs/workers`) import
 * `attachWebSocket` / `TopicRegistry` from here too.
 */

import {
  attachWebSocket,
  TopicRegistry,
  wrapWebSocketMessageValidation,
} from "./server/websocket.ts"
import { createBunWsHandlers } from "./server/ws-bun.ts"
import { setWsRuntime } from "./server/ws-hook.ts"

setWsRuntime({
  wrapHandler: wrapWebSocketMessageValidation,
  createTopics: () => new TopicRegistry(),
  bunHandlers: createBunWsHandlers,
  attach: attachWebSocket,
})

export type {
  NifraWebSocket,
  StandardWebSocket,
  WebSocketContext,
  WebSocketData,
  WebSocketHandler,
  WebSocketUpgradeOutcome,
} from "./server/websocket.ts"
export { attachWebSocket, TopicRegistry, wrapWebSocketMessageValidation }
