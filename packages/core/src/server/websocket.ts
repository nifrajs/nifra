/**
 * WebSocket seam - portable types shared by `@nifrajs/core`'s `app.ws()` and every serving adapter
 * (Bun `listen()`, `@nifrajs/node`, `@nifrajs/deno`, `toFetchHandler` on Workers). No runtime code here, so
 * it stays edge-safe and dependency-free; each adapter implements {@link NifraWebSocket} over its
 * runtime's native socket and dispatches to the handler.
 *
 * A WS upgrade can't go through `app.fetch` (which has no socket) - it's adapter-integrated. The
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
import { guardDecodedValue, type ProtoPoisoning, parseJsonGuarded } from "./proto-guard.ts"
import { isResponseResult, type StatusResponse } from "./runtime-core.ts"

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
  /** Close the connection, with a code an endpoint may send (1000-1003, 1007-1014, 3000-4999;
   * 1000 when none is given, on every runtime) and a reason of at most 123 UTF-8 bytes. Any other
   * close throws a `RangeError`, and the socket stays open. */
  close(code?: number, reason?: string): void
  /** `WebSocket.readyState` (0 CONNECTING · 1 OPEN · 2 CLOSING · 3 CLOSED). */
  readonly readyState: number
  /** Join a pub/sub topic - `app.publish(topic, data)` then reaches this connection. Idempotent. */
  subscribe(topic: string): void
  /** Leave a pub/sub topic. Idempotent. (All topics are dropped automatically on close.) */
  unsubscribe(topic: string): void
  /** Per-connection state - seeded by `upgrade()`, mutable for the connection's lifetime. */
  data: Data
  /** Escape hatch to the runtime's native socket (Bun `ServerWebSocket`, Web `WebSocket`, `ws`). */
  readonly raw: unknown
}

/**
 * In-process pub/sub for `ws.subscribe(topic)` + `app.publish(topic, data)`. **Single-instance only** -
 * topics live in this process's memory, so a multi-instance deploy (multiple servers behind a load
 * balancer) needs an external fan-out (Redis pub/sub, a Cloudflare Durable Object, NATS, …) bridged to
 * `app.publish`. The same registry instance is shared by an app's connections and its `publish`.
 */
export class TopicRegistry {
  private readonly topics = new Map<string, Set<NifraWebSocket>>()
  private readonly memberships = new WeakMap<NifraWebSocket, Set<string>>()

  subscribe(topic: string, ws: NifraWebSocket): void {
    // CLOSING or CLOSED: close has run, or is about to run, `unsubscribeAll`, so an async handler's
    // late subscribe would hold the dead socket for good.
    if (ws.readyState >= 2) return
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
      if (subs.size === 0) this.topics.delete(topic) // reclaim empty topics - no unbounded growth
    }
    this.memberships.get(ws)?.delete(topic)
  }

  /** Drop every subscription for a connection - called on close so a registry never leaks dead sockets. */
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
 * The request-context subset the `upgrade()` guard sees - the same lazy accessors a route handler's
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
  Extra = unknown,
> {
  /**
   * Cross-site WebSocket hijacking (CSWSH) guard - checked BEFORE `upgrade()`. A browser does not
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
   * not authentication - pair it with auth in `upgrade()`.
   */
  allowedOrigins?: ReadonlyArray<string> | ((origin: string | null) => boolean)
  /**
   * The capability ids this socket's code may reach, exactly as an HTTP route's `capabilities`.
   * `nifra capabilities check` compares them with the effects reachable from the module that
   * registers the socket. The handshake context carries the guard, so a runtime beacon in `upgrade()`
   * (or one that keeps `c`) fails closed on an undeclared capability.
   */
  capabilities?: readonly string[]
  /**
   * Runs in the HTTP request context **before** the upgrade, last in the chain an HTTP `GET` to the
   * same path runs: after {@link allowedOrigins}, then the `authenticate()` stages, `derive`s and
   * `beforeHandle`s registered before this route, any of which can refuse the handshake. `c` carries
   * what they derived. Return the initial per-connection `data` (→ `ws.data`), or a `Response` or
   * `status(...)` to **reject** the upgrade (the client never connects). Omit to accept with
   * `data: undefined`. A thrown `Response` rejects with it; any other throw goes to the route's
   * `onError` hooks, then a flat 500.
   */
  upgrade?(c: WebSocketContext<Env> & Extra): MaybePromise<Data | Response | StatusResponse>
  /**
   * Contract-first messages: a Standard Schema (`t`, zod, valibot, …) validating each **inbound** frame.
   * Text frames are parsed as JSON first. When set, `message` receives the validated, typed value; a
   * non-JSON or schema-invalid frame is routed to `onInvalidMessage` (or dropped if that's omitted).
   */
  messageSchema?: Schema
  /**
   * The **outbound** frame contract (server → client), a Standard Schema. Purely type-level: it types
   * the frames the typed client's `.ws()` handle receives, and documents what this route pushes. The
   * server does NOT runtime-validate its own sends by default - the inbound `messageSchema` guards the
   * trust boundary; outbound honesty is the handler author's code. Set {@link validateSend} to opt into
   * a synchronous runtime check of JSON text/UTF-8 binary frames.
   */
  sendSchema?: Send
  /**
   * Opt-in runtime enforcement for {@link sendSchema}. Invalid JSON, schema failures, and async
   * validators are dropped before the native socket's `send()` runs and reported to `error()` when it
   * exists. This is a development/contract check for the server's own output, not an inbound security
   * boundary. It is off by default and requires `sendSchema` at registration.
   */
  validateSend?: boolean
  /** Decode versioned transport frames before inbound schema validation. Omit for legacy JSON. */
  transport?: {
    readonly registry: TransportCodecRegistry
    readonly maxBytes?: number
    /** Whether an inbound frame may decode to a value holding a `RegExp`. Default `false`: a
     * client-supplied pattern is code (catastrophic backtracking stalls the event loop), so such a
     * frame is treated as invalid. */
    readonly acceptRegExp?: boolean
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
  /** The connection closed. `code` and `reason` are the server's own close when it closed first
   * (`ws.close()`, or 1009 for a message over the cap), the peer's when the peer did, and 1006 when
   * the connection dropped without a close frame. */
  close?(ws: NifraWebSocket<Data>, code: number, reason: string): MaybePromise<void>
  error?(ws: NifraWebSocket<Data>, error: unknown): MaybePromise<void>
}

/**
 * The outcome of `app.resolveWebSocketUpgrade(req)` - for serving adapters:
 * - `pass` - not a WS upgrade for a registered WS route; handle as a normal HTTP request.
 * - `reject` - a WS route matched but `upgrade()` rejected (or the path was malformed); return `response`.
 * - `upgrade` - perform the runtime upgrade, then dispatch the native socket's events to `handler`,
 *   seeding `ws.data` with `data`.
 */
export type WebSocketUpgradeOutcome =
  | { readonly kind: "pass" }
  | { readonly kind: "reject"; readonly response: Response }
  | {
      readonly kind: "upgrade"
      readonly handler: WebSocketHandler
      readonly data: unknown
      /** The app's pub/sub registry - the adapter wires `ws.subscribe` + close-cleanup to it. */
      readonly pubsub: TopicRegistry
      /** The installed runtime's {@link attachWebSocket}, carried on the outcome so an adapter can wire
       * a standard socket without a static import of the WS implementation (which would defeat the
       * `.use(websocket())` tree-shaking). `@nifrajs/workers` may import `attachWebSocket` directly instead. */
      readonly attach: WsAttach
      readonly maxPayloadBytes?: number
      /** Builds `ws.send` over an adapter's native send, enforcing the route's {@link
       * WebSocketHandler.validateSend}. Set on every outcome a nifra app produces; an adapter that
       * wires its own sockets instead of calling `attach` (Node, Deno) builds `send` with it. */
      readonly sender?: WsSender
    }

/** The send-builder the upgrade outcome carries (the installed runtime's `sender`). */
export type WsSender = (
  handler: WebSocketHandler,
  send: (payload: string | ArrayBufferView | ArrayBuffer) => void,
  onError: (error: unknown) => void,
) => (payload: string | ArrayBufferView | ArrayBuffer) => void

/** The socket-wiring signature the upgrade outcome carries (the installed runtime's `attach`). */
export type WsAttach = (
  socket: StandardWebSocket,
  handler: WebSocketHandler,
  data: unknown,
  options: { openNow: boolean; pubsub: TopicRegistry; maxPayloadBytes?: number | undefined },
) => NifraWebSocket

/**
 * A standard server-side `WebSocket` - the half returned by Deno's `Deno.upgradeWebSocket` and the
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
  return new Uint8Array(0) // unknown (e.g. an unconverted Blob) - adapters set binaryType to avoid this
}

/**
 * Wire a standard server-side `WebSocket` to a nifra {@link WebSocketHandler}, returning the portable
 * {@link NifraWebSocket}. Shared by the Deno and Workers bridges. `openNow` fires `open` immediately
 * (Workers, where the socket is already open after `accept()`); otherwise `open` waits for the socket's
 * `open` event (Deno). Lifecycle callbacks are error-isolated - a throw (or async rejection) routes to
 * `error()` and never tears the process down; binary frames are normalized to `Uint8Array`.
 */
export function attachWebSocket<
  Data = unknown,
  Env = unknown,
  Schema extends StandardSchemaV1 | undefined = undefined,
  Send extends StandardSchemaV1 | undefined = undefined,
>(
  socket: StandardWebSocket,
  handler: WebSocketHandler<Data, Env, Schema, Send>,
  data: unknown,
  options: { openNow: boolean; pubsub: TopicRegistry; maxPayloadBytes?: number | undefined },
): NifraWebSocket<Data> {
  const { pubsub } = options
  let ws!: NifraWebSocket<Data>
  const reportError = (error: unknown): void => {
    if (handler.error === undefined) return
    try {
      const r = handler.error(ws, error)
      if (r instanceof Promise) r.catch(() => {})
    } catch {
      /* the error handler itself failed - last resort, swallow */
    }
  }
  const send = createWebSocketSender(
    (payload) => socket.send(payload),
    handler.sendSchema,
    handler.validateSend,
    handler.transport,
    reportError,
  )
  // The runtime's close event carries the peer's echo, which may drop the reason; `close` is given
  // the server's own close when the server closed first, as on Bun.
  let sentClose: readonly [number, string] | undefined
  // A close with no code is 1000 here as on Bun, whose close() cannot send one without a status.
  const closeSocket = (code = 1000, reason?: string): void => {
    if (sentClose === undefined && socket.readyState <= 1) sentClose = [code, reason ?? ""]
    socket.close(code, reason)
  }
  ws = {
    send,
    close: (code, reason) => {
      assertCloseArgs(code, reason)
      closeSocket(code, reason)
    },
    get readyState() {
      return socket.readyState
    },
    subscribe: (topic) => pubsub.subscribe(topic, ws),
    unsubscribe: (topic) => pubsub.unsubscribe(topic, ws),
    data: data as Data,
    raw: socket,
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
  const maxPayloadBytes = options.maxPayloadBytes
  socket.addEventListener("message", (event: { readonly data: unknown }) => {
    const raw = event.data
    const payload: WebSocketData = typeof raw === "string" ? raw : toBinary(raw)
    // The runtime hands over each message whole, so this bounds what reaches the handler, not what
    // the runtime buffered to deliver it.
    if (maxPayloadBytes !== undefined && exceedsPayloadCap(payload, maxPayloadBytes)) {
      closeSocket(1009, "message too large")
      return
    }
    safe(() =>
      (
        handler.message as
          | ((socket: NifraWebSocket<Data>, value: WebSocketData) => MaybePromise<void>)
          | undefined
      )?.(ws, payload),
    )
  })
  socket.addEventListener(
    "close",
    (event: { readonly code?: number; readonly reason?: string }) => {
      pubsub.unsubscribeAll(ws) // drop topic subscriptions so the registry never holds a dead socket
      const [code, reason] = sentClose ?? [event.code ?? 1005, event.reason ?? ""]
      safe(() => handler.close?.(ws, code, reason))
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

// `@nifrajs/deno` and `@nifrajs/node` run generated copies of `UTF8_BUFFER`, `exceedsPayloadCap`,
// `utf8ExceedsCap` and `assertCloseArgs` (scripts/gen-vendored.ts), so these reference nothing else
// in this module.
/** Bun, Node, Deno and workerd from about 2026 expose `Buffer`, whose native `byteLength` sizes text
 * without copying it; a Worker on an older compatibility date has none. */
const UTF8_BUFFER: { byteLength(text: string): number } | undefined = Reflect.get(
  globalThis,
  "Buffer",
)

/** Whether a message is over `cap` UTF-8 bytes, without copying a text one: each UTF-16 unit takes
 * 1-3 bytes (a surrogate pair 4 for its 2, a lone surrogate the 3 of U+FFFD), so only a length
 * between those bounds is counted. */
export function exceedsPayloadCap(
  message: string | ArrayBuffer | Uint8Array,
  cap: number,
): boolean {
  if (typeof message !== "string") return message.byteLength > cap
  const units = message.length
  if (units > cap) return true
  if (units * 3 <= cap) return false
  if (UTF8_BUFFER === undefined) return utf8ExceedsCap(message, cap)
  return UTF8_BUFFER.byteLength(message) > cap
}

/** `exceedsPayloadCap`'s count where the runtime has no `Buffer`, one UTF-16 unit at a time. */
export function utf8ExceedsCap(message: string, cap: number): boolean {
  const units = message.length
  let bytes = 0
  for (let i = 0; i < units; i++) {
    const unit = message.charCodeAt(i)
    if (unit >= 0xd800 && unit <= 0xdbff && (message.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4
      i++
    } else bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3
    if (bytes > cap) return true
  }
  return false
}

/**
 * Refuse a close RFC 6455 forbids before the runtime sees it: a code outside 1000-1003, 1007-1014 and
 * 3000-4999, a reason over 123 UTF-8 bytes, or a reason without a code. Runtimes disagreed on such a
 * close - Bun and Deno sent it, Node's `ws` threw after marking the socket closing, which left it
 * half-open, and workerd threw - so every adapter throws this `RangeError` first and the socket stays
 * open.
 */
export function assertCloseArgs(code: number | undefined, reason: string | undefined): void {
  if (code === undefined) {
    if (reason !== undefined && reason !== "")
      throw new RangeError("ws.close(): a reason needs a code")
    return
  }
  if (
    !Number.isInteger(code) ||
    !(
      (code >= 1000 && code <= 1003) ||
      (code >= 1007 && code <= 1014) ||
      (code >= 3000 && code <= 4999)
    )
  )
    throw new RangeError(
      `ws.close(): ${code} is not a code a server may send (1000-1003, 1007-1014, 3000-4999)`,
    )
  if (reason !== undefined && exceedsPayloadCap(reason, 123))
    throw new RangeError("ws.close(): the reason is over 123 UTF-8 bytes")
}

type WebSocketSendPayload = string | ArrayBufferView | ArrayBuffer

const OUTBOUND_VALIDATION_ERROR = "outbound WebSocket frame failed sendSchema validation"

function outboundValueOf(
  payload: WebSocketSendPayload,
  transport: WebSocketHandler["transport"],
): unknown {
  const text =
    typeof payload === "string"
      ? payload
      : WS_MESSAGE_DECODER.decode(
          payload instanceof ArrayBuffer
            ? new Uint8Array(payload)
            : new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength),
        )
  return transport === undefined
    ? JSON.parse(text)
    : decodeTransportFrame(text, transport.registry, {
        ...(transport.maxBytes === undefined ? {} : { maxBytes: transport.maxBytes }),
      })
}

/**
 * Build the socket's send function once. The disabled path returns the native sender directly, so
 * the default type-only contract adds no per-frame branch or schema work. Runtime validation is
 * deliberately synchronous: a socket `send()` cannot await an async Standard Schema without changing
 * the portable API, so an async result fails closed and is never sent.
 */
export function createWebSocketSender(
  send: (payload: WebSocketSendPayload) => void,
  schema: StandardSchemaV1 | undefined,
  enabled: boolean | undefined,
  transport: WebSocketHandler["transport"],
  onError: (error: unknown) => void,
): (payload: WebSocketSendPayload) => void {
  if (enabled !== true || schema === undefined) return send
  let reporting = false
  const reportFailure = (error: unknown): void => {
    // An error handler may try to send a diagnostic. Do not recurse forever when that diagnostic also
    // violates the same outbound contract. EVERY failure path reports through here - a path that calls
    // `onError` directly reopens that recursion for the one rejection shape it happens to cover.
    if (reporting) return
    reporting = true
    try {
      onError(error)
    } finally {
      reporting = false
    }
  }
  return (payload) => {
    let value: unknown
    try {
      value = outboundValueOf(payload, transport)
    } catch {
      reportFailure(new Error(OUTBOUND_VALIDATION_ERROR))
      return
    }

    let outcome: ValidationOutcome<unknown> | Promise<ValidationOutcome<unknown>>
    try {
      outcome = validateStandard(schema, value) as
        | ValidationOutcome<unknown>
        | Promise<ValidationOutcome<unknown>>
    } catch {
      reportFailure(new Error(OUTBOUND_VALIDATION_ERROR))
      return
    }
    if (outcome instanceof Promise) {
      // Do not await or send later: the portable `send()` contract is synchronous. Attach a rejection
      // handler so a validator that rejects cannot become an unhandled process-level rejection.
      outcome.catch(() => {})
      reportFailure(new Error(`${OUTBOUND_VALIDATION_ERROR}; validator must be synchronous`))
      return
    }
    if (!outcome.ok) {
      reportFailure(new Error(OUTBOUND_VALIDATION_ERROR))
      return
    }
    send(payload)
  }
}

/** {@link createWebSocketSender} configured from a route's handler: the outcome's `sender`. */
export const webSocketSender: WsSender = (handler, send, onError) =>
  createWebSocketSender(send, handler.sendSchema, handler.validateSend, handler.transport, onError)

/**
 * If the handler declares a `messageSchema`, return a copy whose `message` validates each frame -
 * parse as JSON, run the Standard Schema, then call the user's `message` with the typed value, or
 * `onInvalidMessage` on failure. Returns the handler unchanged when no schema is set. Called once at
 * `app.ws()` registration, so every adapter dispatches validated messages with no per-adapter code.
 * `protoPoisoning` is the app's body policy: a frame with a `__proto__` key gets what a JSON body
 * with one gets, and under `"reject"` reads as invalid JSON.
 */
/** `upgrade()`'s acceptance, wrapped so a handshake's route chain tells it from an early result such
 * as a guard's `Response` or a rejected auth stage. */
class HandshakeAccepted {
  readonly data: unknown
  constructor(data: unknown) {
    this.data = data
  }
}

const acceptHandshake = (value: unknown): unknown =>
  value instanceof Response || isResponseResult(value) ? value : new HandshakeAccepted(value)

/** The step a handshake's route chain ends in: the route's `upgrade()`, or an acceptance without data. */
export function handshakeUpgradeStep(
  handler: WebSocketHandler,
): (ctx: WebSocketContext) => unknown {
  return (ctx) => {
    const data = handler.upgrade?.(ctx)
    return data instanceof Promise ? data.then(acceptHandshake) : acceptHandshake(data)
  }
}

/** The acceptance a handshake's route chain ended in, or `undefined` when the chain refused it. */
export function acceptedHandshake(result: unknown): { readonly data: unknown } | undefined {
  return result instanceof HandshakeAccepted ? result : undefined
}

export function wrapWebSocketMessageValidation(
  handler: WebSocketHandler,
  protoPoisoning: ProtoPoisoning = "reject",
): WebSocketHandler {
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
          ? parseJsonGuarded(text, protoPoisoning)
          : guardDecodedValue(
              decodeTransportFrame(text, handler.transport.registry, {
                ...(handler.transport.maxBytes === undefined
                  ? {}
                  : { maxBytes: handler.transport.maxBytes }),
              }),
              protoPoisoning,
              handler.transport.acceptRegExp === true,
            )
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
