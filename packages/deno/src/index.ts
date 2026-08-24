/**
 * Run a nifra app (or any Web-`fetch` handler) on Deno via `Deno.serve`.
 *
 *   import { serve } from "@nifrajs/deno"
 *   import { server } from "@nifrajs/core/server"
 *   const app = server().get("/", () => ({ ok: true }))
 *   await serve(app, { port: 3000 })
 *
 * `Deno.serve`'s handler already receives a Web `Request` and returns a `Response`, so -
 * unlike `@nifrajs/node` - there's no stream bridge: the app's `fetch` *is* the handler.
 * This adapter adds a Bun-`listen()`-style graceful `stop()` (Deno's `shutdown()` drains
 * in-flight requests) and opt-in signal handling. The app-level request timeout and body
 * cap ride along inside `app.fetch`, so they apply here with no extra wiring.
 */
// WebSocket types: structurally mirrored from `@nifrajs/core` so this adapter keeps zero dependency on
// nifra (and `deno check` never has to resolve `@nifrajs/core`'s types). The WS dispatch is inlined below,
// mirroring core's `attachWebSocket`; kept in lockstep by the live `deno run` WS round-trip.

/** A received frame, normalized: text → `string`, binary → `Uint8Array`. */
type NifraWsData = string | Uint8Array

/** The portable socket a nifra WS handler sees (mirror of core's `NifraWebSocket`). */
interface NifraWs {
  send(data: string | ArrayBufferView | ArrayBuffer): void
  close(code?: number, reason?: string): void
  readonly readyState: number
  subscribe(topic: string): void
  unsubscribe(topic: string): void
  data: unknown
  readonly raw: unknown
}

/** A nifra WS route's post-upgrade lifecycle (mirror of core's `WebSocketHandler`). */
interface NifraWsHandler {
  open?(ws: NifraWs): void | Promise<void>
  message?(ws: NifraWs, data: NifraWsData): void | Promise<void>
  close?(ws: NifraWs, code: number, reason: string): void | Promise<void>
  error?(ws: NifraWs, error: unknown): void | Promise<void>
}

/** Mirror of core's `TopicRegistry` surface - the app's pub/sub the adapter wires `ws.subscribe` to. */
interface WsPubSub {
  subscribe(topic: string, ws: NifraWs): void
  unsubscribe(topic: string, ws: NifraWs): void
  unsubscribeAll(ws: NifraWs): void
}

/** Mirror of core's `WebSocketUpgradeOutcome` - what `resolveWebSocketUpgrade` returns. */
type WsUpgradeOutcome =
  | { readonly kind: "pass" }
  | { readonly kind: "reject"; readonly response: Response }
  | {
      readonly kind: "upgrade"
      readonly handler: NifraWsHandler
      readonly data: unknown
      readonly pubsub: WsPubSub
      readonly maxPayloadBytes?: number
    }

/** Anything exposing a Web `fetch` handler - a nifra `app`, for instance. */
export interface FetchHandler {
  fetch(request: Request, platform?: { readonly clientIp?: string }): Response | Promise<Response>
  /** A nifra app also exposes this WS-upgrade seam; present → this adapter serves `app.ws()` routes
   * via `Deno.upgradeWebSocket`. Absent (a plain `{ fetch }` handler) → HTTP only. */
  resolveWebSocketUpgrade?(request: Request): WsUpgradeOutcome | Promise<WsUpgradeOutcome>
}

export interface ServeOptions {
  readonly port: number
  readonly hostname?: string
  /**
   * Install SIGTERM/SIGINT handlers that call `stop()` for a graceful drain on
   * `docker stop` / Ctrl-C. Off by default - taking over process signals is opt-in,
   * mirroring nifra's Bun `listen({ gracefulSignals })`.
   */
  readonly signals?: boolean
}

export interface DenoServer {
  /** The bound port (resolved when `port: 0` is requested). */
  readonly port: number
  /**
   * Stop accepting connections, let in-flight requests drain (up to `drainMs`), then
   * force-close stragglers. Mirrors nifra's Bun `stop()`.
   */
  stop(options?: { drainMs?: number }): Promise<void>
}

const DEFAULT_DRAIN_MS = 10_000

/**
 * Serve a Web-`fetch` app on Deno. Returns once bound, so `port` is the real one
 * (matters for `port: 0`).
 */
export function serve(app: FetchHandler, options: ServeOptions): Promise<DenoServer> {
  // Aborting this signal force-closes the server - used when the drain deadline elapses.
  const controller = new AbortController()
  let closed = false
  let activeRequests = 0
  let idleResolvers: Array<() => void> = []
  // Bound once: a plain `{ fetch }` handler leaves this undefined and skips the seam entirely.
  const resolveWs = app.resolveWebSocketUpgrade?.bind(app)

  function beginRequest(): () => void {
    activeRequests += 1
    let released = false
    return () => {
      if (released) return
      released = true
      activeRequests -= 1
      if (activeRequests !== 0) return
      const resolvers = idleResolvers
      idleResolvers = []
      for (const resolve of resolvers) resolve()
    }
  }

  function waitForIdle(): Promise<void> {
    if (activeRequests === 0) return Promise.resolve()
    return new Promise((resolve) => idleResolvers.push(resolve))
  }

  function settleRequest<T>(result: T | Promise<T>, release: () => void): T | Promise<T> {
    if (result instanceof Promise) return result.finally(release)
    release()
    return result
  }

  const httpServer = Deno.serve(
    {
      port: options.port,
      hostname: options.hostname,
      signal: controller.signal,
      onListen() {}, // suppress Deno's default "Listening on …" banner
    },
    (request, info: { readonly remoteAddr?: { readonly hostname?: string } }) => {
      // Deno has no separate "stop accepting" primitive: shutdown() starts closing the same
      // resource that the signal abort listener owns. Calling abort after shutdown began is a
      // BadResource on current Deno releases, so mark the adapter closed first and reject the tiny
      // window of requests that can arrive while existing handlers drain. The one abort in stop()
      // then owns the resource close for every Deno version.
      if (closed) return serverClosing()
      const release = beginRequest()
      // WebSocket upgrade for a registered `app.ws()` route → Deno.upgradeWebSocket. The shared
      // resolveWebSocketUpgrade seam runs the route's upgrade() guard; pass falls through to HTTP.
      //
      // Deliberately NOT gated on reading the `Upgrade` header here. That gate looks like a cheap
      // pre-filter but is the opposite: the seam already returns `pass` on a WS-free app without
      // touching headers (it checks its ws-route count first), whereas reading `upgrade` forces the
      // runtime to materialize the request's header list on EVERY plain HTTP request. Deno bills
      // that lazily, so the probe cost ~7% of throughput on a bare route under Deno 2.9 (~4.5% on
      // 2.8) - i.e. the gate charged every request to save nothing. Calling the seam directly puts
      // the adapter within a few percent of a hand-written `Deno.serve` handler.
      if (resolveWs !== undefined) {
        try {
          const outcome = resolveWs(request)
          if (outcome instanceof Promise) {
            return settleRequest(
              outcome.then((o) => finishWs(o, request, info)).catch(() => internalError()),
              release,
            )
          }
          return settleRequest(finishWs(outcome, request, info), release)
        } catch {
          release()
          return internalError()
        }
      }
      return settleRequest(runFetch(request, info), release)
    },
  )

  /** Resolve a settled upgrade outcome. Hoisted out of the request closure so the common `pass`
   * (plain HTTP) case allocates nothing per request. */
  function finishWs(
    o: WsUpgradeOutcome,
    request: Request,
    info: { readonly remoteAddr?: { readonly hostname?: string } },
  ): Response | Promise<Response> {
    if (o.kind === "pass") return runFetch(request, info)
    if (o.kind === "reject") return o.response
    const { socket, response } = Deno.upgradeWebSocket(request)
    attachDenoWebSocket(socket, o.handler, o.data, o.pubsub, o.maxPayloadBytes)
    return response
  }

  function runFetch(
    request: Request,
    info: { readonly remoteAddr?: { readonly hostname?: string } },
  ): Response | Promise<Response> {
    try {
      // `Deno.serve` delimited this body with its own HTTP parser, so the declared Content-Length is
      // the transport frame, not a caller's hint - the same guarantee Bun's native routes carry. The
      // mark lets core's JSON lane keep the runtime's fused parse instead of copying the body out to
      // recount it. Registered symbol because this adapter deliberately never imports core.
      ;(request as unknown as Record<symbol, unknown>)[Symbol.for("nifra.body.trustedFraming")] =
        true
      // Deno's socket peer (the one address a client can't forge) → `c.clientIp`, unless the app's
      // `clientIp` trust declaration derives it from the forwarding chain instead.
      const clientIp = info.remoteAddr?.hostname
      const response =
        clientIp === undefined ? app.fetch(request) : app.fetch(request, { clientIp })
      return response instanceof Promise ? response.catch(() => internalError()) : response
    } catch {
      // nifra's app.fetch returns its own 500; this guards non-nifra handlers and never
      // lets a stack reach the wire (or Deno's default error logger).
      return internalError()
    }
  }

  const onSignal = (): void => {
    void stop()
  }

  async function stop({ drainMs = DEFAULT_DRAIN_MS }: { drainMs?: number } = {}): Promise<void> {
    if (closed) return // idempotent
    closed = true
    if (options.signals === true) {
      Deno.removeSignalListener("SIGTERM", onSignal)
      Deno.removeSignalListener("SIGINT", onSignal)
    }
    // Do not call httpServer.shutdown() until the application handlers have drained. Deno attaches
    // shutdown() and the signal to the same underlying resource; once shutdown() starts, aborting
    // that signal can throw BadResource (and Deno reports the event-listener exception outside this
    // Promise). If the application drains in time, shutdown() gets to flush the final Responses. If
    // the deadline wins, the signal is the only close operation and force-closes the stragglers.
    const timeoutMs = Number.isFinite(drainMs) ? Math.max(0, drainMs) : DEFAULT_DRAIN_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<"deadline">((resolve) => {
      timer = setTimeout(() => resolve("deadline"), timeoutMs)
    })
    const drained = waitForIdle().then(() => "drained" as const)
    const outcome = await Promise.race([drained, deadline])
    if (timer !== undefined) clearTimeout(timer)
    if (outcome === "drained") await httpServer.shutdown()
    else controller.abort()
    await httpServer.finished
  }

  if (options.signals === true) {
    Deno.addSignalListener("SIGTERM", onSignal)
    Deno.addSignalListener("SIGINT", onSignal)
  }

  // `addr` is populated synchronously on the returned server (verified via spike).
  const addr = httpServer.addr as Deno.NetAddr
  return Promise.resolve({ port: addr.port, stop })
}

/** Shared across sockets: only a capped route ever uses it, so a per-connection one would allocate
 * for every client to serve a feature most apps never enable. */
const payloadEncoder = new TextEncoder()

function internalError(): Response {
  return new Response('{"ok":false,"error":"internal_error"}', {
    status: 500,
    headers: { "content-type": "application/json" },
  })
}

function serverClosing(): Response {
  return new Response('{"ok":false,"error":"server_closing"}', {
    status: 503,
    headers: { connection: "close", "content-type": "application/json" },
  })
}

/**
 * Wire Deno's standard `WebSocket` (from `Deno.upgradeWebSocket`) to a nifra WS handler. The Deno copy
 * of `@nifrajs/core`'s `attachWebSocket`, inlined so this adapter keeps no runtime nifra dependency (the
 * core export is unit-tested; this mirror is exercised by the live `deno run` WS round-trip). Binary
 * frames normalize to `Uint8Array`; a thrown or rejected callback routes to `error()` and never tears
 * the connection's event loop down.
 */
function attachDenoWebSocket(
  socket: WebSocket,
  handler: NifraWsHandler,
  data: unknown,
  pubsub: WsPubSub,
  maxPayloadBytes?: number,
): void {
  const ws: NifraWs = {
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
      /* the error handler itself failed - last resort, swallow */
    }
  }
  const safe = (call: () => void | Promise<void>): void => {
    try {
      const r = call()
      if (r instanceof Promise) r.catch(reportError)
    } catch (error) {
      reportError(error)
    }
  }
  socket.binaryType = "arraybuffer" // deliver binary as ArrayBuffer (→ Uint8Array), not Blob
  socket.addEventListener("open", () => safe(() => handler.open?.(ws)))
  socket.addEventListener("message", (event) => {
    const raw: unknown = event.data
    const payload: NifraWsData = typeof raw === "string" ? raw : new Uint8Array(raw as ArrayBuffer)
    // Only a route that declared a cap pays for measuring the frame - sizing a text frame means a
    // full UTF-8 encode and the buffer that comes with it, on every message.
    if (maxPayloadBytes !== undefined) {
      const payloadBytes =
        typeof raw === "string"
          ? payloadEncoder.encode(raw).byteLength
          : (payload as Uint8Array).byteLength
      if (payloadBytes > maxPayloadBytes) {
        socket.close(1009, "message too large")
        return
      }
    }
    safe(() => handler.message?.(ws, payload))
  })
  socket.addEventListener("close", (event) => {
    pubsub.unsubscribeAll(ws) // drop topic subscriptions so the registry never holds a dead socket
    safe(() => handler.close?.(ws, event.code, event.reason))
  })
  socket.addEventListener("error", (event) => reportError(event))
}
