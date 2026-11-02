/**
 * The narrow WebSocket view the zero-dependency adapters read. `@nifrajs/node` and `@nifrajs/deno` run
 * generated copies of these types (scripts/gen-vendored.ts) instead of importing core's, whose handler
 * and outcome types carry the schemas and codecs the adapters never touch.
 */

import type { TopicRegistry, WebSocketHandler, WebSocketUpgradeOutcome } from "./websocket.ts"

/** A received frame, normalized: text → `string`, binary → `Uint8Array`. */
export type NifraWsData = string | Uint8Array

/** The portable socket a nifra WS handler sees: `NifraWebSocket` with its data unknown. */
export interface NifraWs {
  send(data: string | ArrayBufferView | ArrayBuffer): void
  close(code?: number, reason?: string): void
  readonly readyState: number
  subscribe(topic: string): void
  unsubscribe(topic: string): void
  data: unknown
  readonly raw: unknown
}

/** The `TopicRegistry` surface the adapter wires `ws.subscribe` to. */
export interface WsPubSub {
  subscribe(topic: string, ws: NifraWs): void
  unsubscribe(topic: string, ws: NifraWs): void
  unsubscribeAll(ws: NifraWs): void
}

/** The post-upgrade callbacks of a `WebSocketHandler`. */
export interface NifraWsHandler {
  open?(ws: NifraWs): void | Promise<void>
  message?(ws: NifraWs, data: NifraWsData): void | Promise<void>
  close?(ws: NifraWs, code: number, reason: string): void | Promise<void>
  error?(ws: NifraWs, error: unknown): void | Promise<void>
}

/** What `resolveWebSocketUpgrade` returns, as the adapters read it. */
export type WsUpgradeOutcome =
  | { readonly kind: "pass" }
  | { readonly kind: "reject"; readonly response: Response }
  | {
      readonly kind: "upgrade"
      readonly handler: NifraWsHandler
      readonly data: unknown
      readonly pubsub: WsPubSub
      readonly maxPayloadBytes?: number
      /** Builds `ws.send` with the route's outbound contract (`validateSend`). */
      sender?(
        handler: NifraWsHandler,
        send: (payload: string | ArrayBufferView | ArrayBuffer) => void,
        onError: (error: unknown) => void,
      ): (payload: string | ArrayBufferView | ArrayBuffer) => void
    }

type Fits<View, Actual extends View> = Actual

// Core's own types must stay assignable to the view, so a change the adapters cannot read fails here.
export type CoreFitsAdapterView = [
  Fits<WsUpgradeOutcome, WebSocketUpgradeOutcome>,
  Fits<NifraWsHandler, WebSocketHandler>,
  Fits<WsPubSub, TopicRegistry>,
]
