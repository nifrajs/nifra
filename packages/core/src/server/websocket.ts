/**
 * WebSocket seam — portable types shared by `@nifrajs/core`'s `app.ws()` and every serving adapter
 * (Bun `listen()`, `@nifrajs/node`, `@nifrajs/deno`, `toFetchHandler` on Workers). No runtime code here, so
 * it stays edge-safe and dependency-free; each adapter implements {@link NifraWebSocket} over its
 * runtime's native socket and dispatches to the handler.
 *
 * A WS upgrade can't go through `app.fetch` (which has no socket) — it's adapter-integrated. The
 * adapter calls `app.resolveWebSocketUpgrade(req)` (runs the route's `upgrade()` guard in a real
 * request context), then performs the runtime upgrade with the returned data.
 */

import type {
  InferOutput,
  StandardIssue,
  StandardSchemaV1,
  ValidationOutcome,
} from "../schema/standard.ts"
import { validateStandard } from "../schema/standard.ts"
import { decodeTransportFrame, type TransportCodecRegistry } from "../transport-codec.ts"

type MaybePromise<T> = T | Promise<T>

/** A received frame, normalized across runtimes: text → `string`, binary → `Uint8Array`. */
export type WebSocketData = string | Uint8Array

/** The value `message` receives: the schema's validated output when a `messageSchema` is set on the
 * handler, otherwise the raw frame (`string | Uint8Array`). */
type WsMessageInput<Schema extends StandardSchemaV1 | undefined> = Schema extends StandardSchemaV1
  ? InferOutput<Schema>
  : WebSocketData

/** The portable socket handed to WS lifecycle callbacks. Each adapter wraps its native socket. */
export interface NifraWebSocket<Data = unknown> {
  /** Send a text (`string`) or binary (`ArrayBuffer`/typed-array) frame. No-op once closed. */
  send(data: string | ArrayBufferView | ArrayBuffer): void
  /** Close the connection (optional code 1000–4999 + short reason). */
  close(code?: number, reason?: string): void
  /** `WebSocket.readyState` (0 CONNECTING · 1 OPEN · 2 CLOSING · 3 CLOSED). */
  readonly readyState: number
  /** Join a pub/sub topic — `app.publish(topic, data)` then reaches this connection. Idempotent. */
  subscribe(topic: string): void
  /** Leave a pub/sub topic. Idempotent. (All topics are dropped automatically on close.) */
  unsubscribe(topic: string): void
  /** Per-connection state — seeded by `upgrade()`, mutable for the connection's lifetime. */
  data: Data
  /** Escape hatch to the runtime's native socket (Bun `ServerWebSocket`, Web `WebSocket`, `ws`). */
  readonly raw: unknown
}

/**
 * In-process pub/sub for `ws.subscribe(topic)` + `app.publish(topic, data)`. **Single-instance only** —
 * topics live in this process's memory, so a multi-instance deploy (multiple servers behind a load
 * balancer) needs an external fan-out (Redis pub/sub, a Cloudflare Durable Object, NATS, …) bridged to
 * `app.publish`. The same registry instance is shared by an app's connections and its `publish`.
 */
export class TopicRegistry {
  private readonly topics = new Map<string, Set<NifraWebSocket>>()
  private readonly memberships = new WeakMap<NifraWebSocket, Set<string>>()

  subscribe(topic: string, ws: NifraWebSocket): void {
    let subs = this.topics.get(topic)
    if (subs === undefined) {
      subs = new Set()
      this.topics.set(topic, subs)
    }
    subs.add(ws)
    let mine = this.memberships.get(ws)
    if (mine === undefined) {
      mine = new Set()
      this.memberships.set(ws, mine)
    }
    mine.add(topic)
  }

  unsubscribe(topic: string, ws: NifraWebSocket): void {
    const subs = this.topics.get(topic)
    if (subs !== undefined) {
      subs.delete(ws)
      if (subs.size === 0) this.topics.delete(topic) // reclaim empty topics — no unbounded growth
    }
    this.memberships.get(ws)?.delete(topic)
  }

  /** Drop every subscription for a connection — called on close so a registry never leaks dead sockets. */
  unsubscribeAll(ws: NifraWebSocket): void {
    const mine = this.memberships.get(ws)
    if (mine === undefined) return
    for (const topic of mine) {
      const subs = this.topics.get(topic)
      if (subs !== undefined) {
        subs.delete(ws)
        if (subs.size === 0) this.topics.delete(topic)
      }
    }
    this.memberships.delete(ws)
  }

  /** Send `data` to every connection subscribed to `topic`. Per-socket send errors are isolated. */
  publish(topic: string, data: string | ArrayBufferView | ArrayBuffer): void {
    const subs = this.topics.get(topic)
    if (subs === undefined) return
    for (const ws of subs) {
      try {
        ws.send(data)
      } catch {
        /* a single dead/closing socket must not abort the broadcast to the rest */
      }
    }
  }
}

/**
 * The request-context subset the `upgrade()` guard sees — the same lazy accessors a route handler's
 * `c` has (cookies/headers/env are read straight off the upgrade request). Structurally a slice of the
 * core `RawContext`, so the real context object satisfies it.
 */
export interface WebSocketContext<Env = unknown> {
  readonly req: Request
  readonly params: Record<string, string>
  readonly query: unknown
  readonly cookies: Readonly<Record<string, string>>
  readonly env: Env
  readonly signal: AbortSignal
  readonly waitUntil: (promise: Promise<unknown>) => void
  boundedBody(maxBytes?: number): Promise<Uint8Array>
  boundedJson<T = unknown>(maxBytes?: number): Promise<T>
}

/** A WebSocket route's lifecycle. All callbacks optional; only `message` is needed for an echo. */
export interface WebSocketHandler<
  Data = unknown,
  Env = unknown,
  Schema extends StandardSchemaV1 | undefined = undefined,
  Send extends StandardSchemaV1 | undefined = undefined,
> {
  /**
   * Cross-site WebSocket hijacking (CSWSH) guard — checked BEFORE `upgrade()`. A browser does not
   * apply CORS to WebSocket handshakes and DOES send the page's cookies, so without an Origin check
   * any site can open an authenticated socket to your app. Set this to lock the route to known
   * origins: a string allow-list (exact `Origin` header match) or a predicate. A request whose
   * `Origin` doesn't match (or is absent, for the allow-list form) is rejected with `403` before any
   * per-connection work.
   *
   * **When omitted, the default is same-origin:** a cross-origin BROWSER handshake (an `Origin` header
   * whose host differs from the request's) is rejected with `403`. Non-browser clients (no `Origin`) and
   * same-origin browsers pass. Set this to allow specific cross-origin clients, or `() => true` for a
   * genuinely public socket. Non-browser clients can spoof `Origin`, so this is a browser-CSWSH defense,
   * not authentication — pair it with auth in `upgrade()`.
   */
  allowedOrigins?: ReadonlyArray<string> | ((origin: string | null) => boolean)
  /**
   * Runs in the HTTP request context **before** the upgrade (and after {@link allowedOrigins}) — the
   * place to authenticate or rate-limit. Return the initial per-connection `data` (→ `ws.data`), or a
   * `Response` to **reject** the upgrade (the client never connects). Omit to accept with
   * `data: undefined`. A thrown error rejects with a flat 500.
   */
  upgrade?(c: WebSocketContext<Env>): MaybePromise<Data | Response>
  /**
   * Contract-first messages: a Standard Schema (`t`, zod, valibot, …) validating each **inbound** frame.
   * Text frames are parsed as JSON first. When set, `message` receives the validated, typed value; a
   * non-JSON or schema-invalid frame is routed to `onInvalidMessage` (or dropped if that's omitted).
   */
  messageSchema?: Schema
  /**
   * The **outbound** frame contract (server → client), a Standard Schema. Purely type-level: it types
   * the frames the typed client's `.ws()` handle receives, and documents what this route pushes. The
   * server does NOT runtime-validate its own sends - the inbound `messageSchema` guards the trust
   * boundary; outbound honesty is the handler author's code, checked by tests.
   */
  sendSchema?: Send
  /** Decode versioned transport frames before inbound schema validation. Omit for legacy JSON. */
  transport?: {
    readonly registry: TransportCodecRegistry
    readonly maxBytes?: number
  }
  open?(ws: NifraWebSocket<Data>): MaybePromise<void>
  message?(ws: NifraWebSocket<Data>, data: WsMessageInput<Schema>): MaybePromise<void>
  /** Inbound frame that failed JSON parse or `messageSchema` validation (only fires when a schema is
   * set). `raw` is the original frame; `issues` are the Standard Schema issues (one synthetic issue for
   * a JSON parse failure). Omit to silently drop invalid frames. */
  onInvalidMessage?(
    ws: NifraWebSocket<Data>,
    issues: ReadonlyArray<StandardIssue>,
    raw: WebSocketData,
  ): MaybePromise<void>
  close?(ws: NifraWebSocket<Data>, code: number, reason: string): MaybePromise<void>
  error?(ws: NifraWebSocket<Data>, error: unknown): MaybePromise<void>
}

/**
 * The outcome of `app.resolveWebSocketUpgrade(req)` — for serving adapters:
 * - `pass` — not a WS upgrade for a registered WS route; handle as a normal HTTP request.
 * - `reject` — a WS route matched but `upgrade()` rejected (or the path was malformed); return `response`.
 * - `upgrade` — perform the runtime upgrade, then dispatch the native socket's events to `handler`,
 *   seeding `ws.data` with `data`.
 */
export type WebSocketUpgradeOutcome =
  | { readonly kind: "pass" }
  | { readonly kind: "reject"; readonly response: Response }
  | {
      readonly kind: "upgrade"
      readonly handler: WebSocketHandler
      readonly data: unknown
      /** The app's pub/sub registry — the adapter wires `ws.subscribe` + close-cleanup to it. */
      readonly pubsub: TopicRegistry
      /** The installed runtime's {@link attachWebSocket}, carried on the outcome so an adapter can wire
       * a standard socket without a static import of the WS implementation (which would defeat the
       * `.use(websocket())` tree-shaking). `@nifrajs/workers` may import `attachWebSocket` directly instead. */
      readonly attach: WsAttach
    }

/** The socket-wiring signature the upgrade outcome carries (the installed runtime's `attach`). */
export type WsAttach = (
  socket: StandardWebSocket,
  handler: WebSocketHandler,
  data: unknown,
  options: { openNow: boolean; pubsub: TopicRegistry },
) => NifraWebSocket

/**
 * A standard server-side `WebSocket` — the half returned by Deno's `Deno.upgradeWebSocket` and the
 * Workers `WebSocketPair`. {@link attachWebSocket} wires one to a nifra handler, so the Deno and Workers
 * bridges share all the dispatch/normalization/error-isolation logic (only the upgrade call differs).
 */
export interface StandardWebSocket {
  send(data: string | ArrayBufferView | ArrayBuffer): void
  close(code?: number, reason?: string): void
  readonly readyState: number
  binaryType?: string
  addEventListener(type: string, listener: (event: never) => void): void
}

/** Normalize a received binary frame to `Uint8Array` (text frames stay `string`). */
function toBinary(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) return raw
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw)
  if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  return new Uint8Array(0) // unknown (e.g. an unconverted Blob) — adapters set binaryType to avoid this
}

/**
 * Wire a standard server-side `WebSocket` to a nifra {@link WebSocketHandler}, returning the portable
 * {@link NifraWebSocket}. Shared by the Deno and Workers bridges. `openNow` fires `open` immediately
 * (Workers, where the socket is already open after `accept()`); otherwise `open` waits for the socket's
 * `open` event (Deno). Lifecycle callbacks are error-isolated — a throw (or async rejection) routes to
 * `error()` and never tears the process down; binary frames are normalized to `Uint8Array`.
 */
export function attachWebSocket(
  socket: StandardWebSocket,
  handler: WebSocketHandler,
  data: unknown,
  options: { openNow: boolean; pubsub: TopicRegistry },
): NifraWebSocket {
  const { pubsub } = options
  const ws: NifraWebSocket = {
    send: (payload) => socket.send(payload),
    close: (code, reason) => socket.close(code, reason),
    get readyState() {
      return socket.readyState
    },
    subscribe: (topic) => pubsub.subscribe(topic, ws),
    unsubscribe: (topic) => pubsub.unsubscribe(topic, ws),
    data,
    raw: socket,
  }
  const reportError = (error: unknown): void => {
    if (handler.error === undefined) return
    try {
      const r = handler.error(ws, error)
      if (r instanceof Promise) r.catch(() => {})
    } catch {
      /* the error handler itself failed — last resort, swallow */
    }
  }
  const safe = (call: () => MaybePromise<void>): void => {
    try {
      const r = call()
      if (r instanceof Promise) r.catch(reportError)
    } catch (error) {
      reportError(error)
    }
  }
  // Deliver binary as ArrayBuffer (→ Uint8Array) rather than Blob, where the runtime allows it.
  if ("binaryType" in socket) socket.binaryType = "arraybuffer"
  socket.addEventListener("message", (event: { readonly data: unknown }) => {
    const raw = event.data
    const payload: WebSocketData = typeof raw === "string" ? raw : toBinary(raw)
    safe(() => handler.message?.(ws, payload))
  })
  socket.addEventListener(
    "close",
    (event: { readonly code?: number; readonly reason?: string }) => {
      pubsub.unsubscribeAll(ws) // drop topic subscriptions so the registry never holds a dead socket
      safe(() => handler.close?.(ws, event.code ?? 1005, event.reason ?? ""))
    },
  )
  socket.addEventListener("error", (event: unknown) => reportError(event))
  if (options.openNow) {
    safe(() => handler.open?.(ws))
  } else {
    socket.addEventListener("open", () => safe(() => handler.open?.(ws)))
  }
  return ws
}

const WS_MESSAGE_DECODER = new TextDecoder()

/**
 * If the handler declares a `messageSchema`, return a copy whose `message` validates each frame —
 * parse as JSON, run the Standard Schema, then call the user's `message` with the typed value, or
 * `onInvalidMessage` on failure. Returns the handler unchanged when no schema is set. Called once at
 * `app.ws()` registration, so every adapter dispatches validated messages with no per-adapter code.
 */
export function wrapWebSocketMessageValidation(handler: WebSocketHandler): WebSocketHandler {
  const schema = handler.messageSchema
  if (schema === undefined) return handler
  // The handler is type-erased here; the user's `message` really accepts the schema's validated output
  // (typed at the real call site), so widen its param to `unknown` for the internal call.
  const userMessage = handler.message as
    | ((ws: NifraWebSocket, data: unknown) => MaybePromise<void>)
    | undefined
  const onInvalid = handler.onInvalidMessage
  const validatingMessage = (ws: NifraWebSocket, raw: WebSocketData): MaybePromise<void> => {
    let parsed: unknown
    try {
      const text = typeof raw === "string" ? raw : WS_MESSAGE_DECODER.decode(raw)
      parsed =
        handler.transport === undefined
          ? JSON.parse(text)
          : decodeTransportFrame(text, handler.transport.registry, {
              ...(handler.transport.maxBytes === undefined
                ? {}
                : { maxBytes: handler.transport.maxBytes }),
            })
    } catch {
      return onInvalid?.(ws, [{ message: "invalid JSON" }], raw)
    }
    const outcome = validateStandard(schema, parsed)
    const finish = (o: ValidationOutcome<unknown>): MaybePromise<void> =>
      o.ok ? userMessage?.(ws, o.value) : onInvalid?.(ws, o.issues, raw)
    return outcome instanceof Promise ? outcome.then(finish) : finish(outcome)
  }
  // The wrapped `message` takes the raw frame (adapters pass that) and produces the typed value
  // internally; the stored handler is type-erased, so the signature is sound.
  return { ...handler, message: validatingMessage } as WebSocketHandler
}
