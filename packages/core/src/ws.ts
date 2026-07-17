/**
 * The opt-in WebSocket runtime plugin.
 *
 * `.use(websocket())` enables `app.ws()`:
 *
 *   import { websocket } from "@nifrajs/core/ws"
 *
 *   const app = server().use(websocket()).ws("/chat", { message: (ws, data) => ws.send(data) })
 *
 * Without it, `app.ws()` throws at registration (fail-closed), so an app that never uses WebSockets
 * never evaluates or bundles the WS dispatcher, pub/sub registry, and Bun socket plumbing (~1.5 KB
 * gzipped on the minimal-app size benchmark). The runtime installs on that server instance only -
 * the same `.use()` install seam as `mcp()` / `streaming()` / `idempotency()`, not a process-global
 * or a side-effect import.
 *
 * Serving adapters that wire standard sockets themselves (`@nifrajs/workers`) import
 * `attachWebSocket` / `TopicRegistry` from here too.
 */

import { INSTALL_WS } from "./server/install.ts"
import type { IdentityPlugin } from "./server/plugin.ts"
import type { AnyServer } from "./server/server.ts"
import {
  attachWebSocket,
  TopicRegistry,
  wrapWebSocketMessageValidation,
} from "./server/websocket.ts"
import { createBunWsHandlers } from "./server/ws-bun.ts"
import type { WsRuntime } from "./server/ws-hook.ts"

const WS_RUNTIME: WsRuntime = {
  wrapHandler: wrapWebSocketMessageValidation,
  createTopics: () => new TopicRegistry(),
  bunHandlers: createBunWsHandlers,
  attach: attachWebSocket,
}

/** The install seam a server exposes so the `websocket()` plugin can hand it the runtime. */
interface WsInstallable {
  [INSTALL_WS](runtime: WsRuntime): void
}

/**
 * Enable WebSocket routes on a server: `.use(websocket())` turns on `app.ws()`. Applying it twice is
 * a no-op (named plugin dedupe).
 */
export function websocket(): IdentityPlugin {
  const apply = <S extends AnyServer>(app: S): S => {
    ;(app as unknown as WsInstallable)[INSTALL_WS](WS_RUNTIME)
    return app
  }
  return Object.assign(apply, { pluginName: "nifra:websocket" }) as IdentityPlugin
}

export type {
  NifraWebSocket,
  StandardWebSocket,
  WebSocketContext,
  WebSocketData,
  WebSocketHandler,
  WebSocketUpgradeOutcome,
} from "./server/websocket.ts"
export { attachWebSocket, TopicRegistry, wrapWebSocketMessageValidation }
