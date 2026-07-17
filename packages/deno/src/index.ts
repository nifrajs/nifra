/**
 * Run a nifra app (or any Web-`fetch` handler) on Deno via `Deno.serve`.
 *
 *   import { serve } from "@nifrajs/deno"
 *   import { server } from "@nifrajs/core/server"
 *   const app = server().get("/", () => ({ ok: true }))
 *   await serve(app, { port: 3000 })
 *
 * `Deno.serve`'s handler already receives a Web `Request` and returns a `Response`, so —
 * unlike `@nifrajs/node` — there's no stream bridge: the app's `fetch` *is* the handler.
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

/** Mirror of core's `TopicRegistry` surface — the app's pub/sub the adapter wires `ws.subscribe` to. */
interface WsPubSub {
  subscribe(topic: string, ws: NifraWs): void
  unsubscribe(topic: string, ws: NifraWs): void
  unsubscribeAll(ws: NifraWs): void
}

/** Mirror of core's `WebSocketUpgradeOutcome` — what `resolveWebSocketUpgrade` returns. */
type WsUpgradeOutcome =
  | { readonly kind: "pass" }
  | { readonly kind: "reject"; readonly response: Response }
  | {
      readonly kind: "upgrade"
      readonly handler: NifraWsHandler
      readonly data: unknown
      readonly pubsub: WsPubSub
    }

/** Anything exposing a Web `fetch` handler — a nifra `app`, for instance. */
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
   * `docker stop` / Ctrl-C. Off by default — taking over process signals is opt-in,
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
  // Aborting this signal force-closes the server — used when the drain deadline elapses.
  const controller = new AbortController()
  let closed = false

  const httpServer = Deno.serve(
    {
      port: options.port,
      hostname: options.hostname,
      signal: controller.signal,
      onListen() {}, // suppress Deno's default "Listening on …" banner
    },
    (request, info: { readonly remoteAddr?: { readonly hostname?: string } }) => {
      // WebSocket upgrade for a registered `app.ws()` route → Deno.upgradeWebSocket. The shared
      // resolveWebSocketUpgrade seam runs the route's upgrade() guard; pass falls through to HTTP.
      //
      // Gate on the `Upgrade: websocket` header first: a nifra app ALWAYS exposes
      // resolveWebSocketUpgrade, so without this, every plain HTTP request would pay for the full
      // upgrade resolution. Every real WS handshake carries this header (Deno.upgradeWebSocket
      // requires it), and a non-upgrade request resolves to "pass" → HTTP anyway — so this only
      // skips wasted work on the hot path, with no behavior change.
      if (
        app.resolveWebSocketUpgrade !== undefined &&
        request.headers.get("upgrade")?.toLowerCase() === "websocket"
      ) {
        let outcome: WsUpgradeOutcome | Promise<WsUpgradeOutcome>
        try {
          outcome = app.resolveWebSocketUpgrade(request)
        } catch {
          return internalError()
        }
        const handleWs = (o: WsUpgradeOutcome): Response | Promise<Response> => {
          if (o.kind === "reject") return o.response
          if (o.kind === "upgrade") {
            const { socket, response } = Deno.upgradeWebSocket(request)
            attachDenoWebSocket(socket, o.handler, o.data, o.pubsub)
            return response
          }
          return runFetch(request, info)
        }
        return outcome instanceof Promise
          ? outcome.then(handleWs).catch(() => internalError())
          : handleWs(outcome)
      }
      return runFetch(request, info)
    },
  )

  function runFetch(
    request: Request,
    info: { readonly remoteAddr?: { readonly hostname?: string } },
  ): Response | Promise<Response> {
    try {
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
    // shutdown() stops accepting + drains in-flight requests. Race it against drainMs;
    // if the deadline wins, abort the signal to force-close stragglers.
    let timer: ReturnType<typeof setTimeout> | undefined
    const drained = httpServer.shutdown().then(() => true)
    const deadline = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), drainMs)
    })
    const drainedInTime = await Promise.race([drained, deadline])
    if (timer !== undefined) clearTimeout(timer)
    if (!drainedInTime) controller.abort()
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

function internalError(): Response {
  return new Response('{"ok":false,"error":"internal_error"}', {
    status: 500,
    headers: { "content-type": "application/json" },
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
      /* the error handler itself failed — last resort, swallow */
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
    safe(() => handler.message?.(ws, payload))
  })
  socket.addEventListener("close", (event) => {
    pubsub.unsubscribeAll(ws) // drop topic subscriptions so the registry never holds a dead socket
    safe(() => handler.close?.(ws, event.code, event.reason))
  })
  socket.addEventListener("error", (event) => reportError(event))
}
