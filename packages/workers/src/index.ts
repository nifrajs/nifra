/**
 * Cloudflare Workers helpers for nifra.
 *
 * On Workers, a WebSocket lives in a single isolate, so a stateless `fetch` can't broadcast across
 * connections — `app.publish(topic, data)` only reaches sockets in the same long-lived process. A
 * **Durable Object** is that long-lived process: {@link createWebSocketHub} builds a DO class that
 * holds every connection and runs the app's pub/sub registry, so `ws.subscribe` / `app.publish` work
 * with their normal nifra semantics. Route upgrades to it with `toFetchHandler(app, { webSocketHub })`.
 *
 *   // worker.ts
 *   import { server, toFetchHandler } from "@nifrajs/core/server"
 *   import { createWebSocketHub } from "@nifrajs/workers"
 *
 *   const app = server().ws("/chat", {
 *     open: (ws) => ws.subscribe("room"),
 *     message: (ws, text) => app.publish("room", text),
 *   })
 *
 *   export const NifraWebSocketHub = createWebSocketHub(app) // bind as NIFRA_WS_HUB in wrangler.toml
 *   export default toFetchHandler(app, { webSocketHub: (env) => env.NIFRA_WS_HUB })
 *
 *   # wrangler.toml
 *   # [[durable_objects.bindings]]
 *   # name = "NIFRA_WS_HUB"
 *   # class_name = "NifraWebSocketHub"
 *   # [[migrations]]
 *   # tag = "v1"
 *   # new_sqlite_classes = ["NifraWebSocketHub"]
 */
// This adapter imports `attachWebSocket` to wire the Workers `WebSocketPair`. The user's backend
// enables `app.ws()` on its own server with `.use(websocket())` from `@nifrajs/core/ws`.

import type { StandardWebSocket, WebSocketUpgradeOutcome } from "@nifrajs/core/server"
import { attachWebSocket } from "@nifrajs/core/ws"

/** The nifra-app surface the hub needs — every `server()` app satisfies it. */
export interface WebSocketHubApp<Env = unknown> {
  resolveWebSocketUpgrade(
    request: Request,
    platform?: { readonly env: Env; readonly waitUntil: (promise: Promise<unknown>) => void },
  ): WebSocketUpgradeOutcome | Promise<WebSocketUpgradeOutcome>
}

/** Structural view of a Durable Object's state (only `waitUntil` is used). */
interface DurableObjectStateLike {
  waitUntil?(promise: Promise<unknown>): void
}

/** Cloudflare's `WebSocketPair` (a Workers global) — structurally typed to avoid a CF types dependency. */
type WebSocketPairCtor = new () => {
  readonly 0: unknown
  readonly 1: StandardWebSocket & { accept(): void }
}

/** The Durable Object class shape `createWebSocketHub` returns. */
export type WebSocketHubClass<Env> = new (
  state: DurableObjectStateLike,
  env: Env,
) => { fetch(request: Request): Promise<Response> }

/**
 * Build a Durable Object class that serves an app's `app.ws()` routes with **cross-connection
 * broadcast**. Every WebSocket accepted here lives in the DO's isolate, and the app's `TopicRegistry`
 * lives there too — so `ws.subscribe(topic)` and `app.publish(topic, data)` (called from the WS
 * lifecycle) reach every connected client. Route upgrades to it via
 * `toFetchHandler(app, { webSocketHub: (env) => env.YOUR_BINDING })`.
 *
 * Single hub: all connections route to one DO instance, so topics are app-global (matching nifra's
 * in-process semantics). Shard by room later by giving the hub a room-derived id.
 */
export function createWebSocketHub<Env = unknown>(
  app: WebSocketHubApp<Env>,
): WebSocketHubClass<Env> {
  return class NifraWebSocketHub {
    readonly #env: Env
    readonly #state: DurableObjectStateLike

    constructor(state: DurableObjectStateLike, env: Env) {
      this.#state = state
      this.#env = env
    }

    async fetch(request: Request): Promise<Response> {
      const platform = {
        env: this.#env,
        waitUntil: (promise: Promise<unknown>) => {
          this.#state.waitUntil?.(promise)
        },
      }
      const outcome = await app.resolveWebSocketUpgrade(request, platform)
      if (outcome.kind === "reject") return outcome.response
      if (outcome.kind !== "upgrade") {
        // Not a registered WS route (or not an upgrade) — nothing for the hub to do.
        return new Response("Upgrade Required", { status: 426 })
      }
      const Pair = (globalThis as { WebSocketPair?: WebSocketPairCtor }).WebSocketPair
      if (Pair === undefined) {
        return new Response("WebSocketPair unavailable (not a Workers runtime)", { status: 500 })
      }
      const pair = new Pair()
      const server = pair[1]
      server.accept()
      // The socket + the app's pub/sub registry both live in this DO isolate, so a broadcast from any
      // connection's `message`/`open` (via `app.publish`) reaches every client held here.
      attachWebSocket(server, outcome.handler, outcome.data, {
        openNow: true,
        pubsub: outcome.pubsub,
      })
      // `webSocket` is a Workers-only `ResponseInit` field, and 101 is only valid on Workers.
      return new Response(null, { status: 101, webSocket: pair[0] } as unknown as ResponseInit)
    }
  }
}
