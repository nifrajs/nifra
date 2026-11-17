/**
 * Serve a nifra app on uWebSockets.js from Node.
 *
 *   import { serve } from "@nifrajs/node-uws"
 *   await serve(app, { port: 3000 })
 *
 * uWS speaks HTTP itself, so there is no `http.Server` or `IncomingMessage` underneath: requests reach
 * the app through the same node-direct lane `@nifrajs/node` uses (`resolveNodeSource`), and answers
 * are written with uWS's corked, copy-once API. See the README for what it does not cover.
 */
import {
  activateAsyncContextFrame,
  enableNodeDirect,
  errorReporterOf,
  type HostPolicyOptions,
  hostPolicyOf,
  lifecycleOf,
  type NodeServeOutcome,
  type NodeStopOptions,
  nodeOutcomeRuntime,
  resolveRequestHost,
  resolveRequestTarget,
} from "@nifrajs/node/transport"
import {
  type DeclarativeRoute,
  declarativeRoutes,
  isServerView,
} from "./generated/declarative-routes.ts"
import { UwsSource } from "./source.ts"
import {
  type AppOptions,
  type HttpRequest,
  type HttpResponse,
  type ListenSocket,
  loadUws,
  type TemplatedApp,
  type Uws,
} from "./uws.ts"
import { statusLine, writeFailure, writeOutcome } from "./write.ts"

export type { NodeStopOptions } from "@nifrajs/node/transport"

/** Anything exposing a Web `fetch` handler - a nifra `app`, for instance. */
export interface FetchHandler {
  fetch(
    request: Request,
    platform?: { readonly clientIp?: string | undefined },
  ): Response | Promise<Response>
  /** Present on every nifra app: the node-direct lane, which skips building a Web `Request`. */
  resolveNodeSource?(
    source: unknown,
    platform?: unknown,
    runtime?: object | undefined,
  ): NodeServeOutcome | Promise<NodeServeOutcome>
}

/**
 * HTTPS from files, in uWS's own terms: it reads the key and certificate itself, so these are paths
 * rather than the PEM text `@nifrajs/node` takes.
 */
export interface UwsTlsOptions {
  readonly keyFileName: string
  readonly certFileName: string
  readonly passphrase?: string
  readonly caFileName?: string
  readonly dhParamsFileName?: string
  readonly sslCiphers?: string
  readonly sslPreferLowMemoryUsage?: boolean
}

export interface ServeOptions extends HostPolicyOptions {
  readonly port: number
  readonly hostname?: string
  /** The scheme `Request.url` carries. `"https"` by default when {@link tls} is set, else `"http"`. */
  readonly protocol?: "http" | "https"
  readonly tls?: UwsTlsOptions
  /** SIGTERM/SIGINT call `stop()`; off by default, as in `@nifrajs/node`. */
  readonly gracefulSignals?: boolean | NodeStopOptions
}

export interface UwsServer {
  /** The bound port (resolved when `port: 0` is requested). */
  readonly port: number
  /**
   * Run the app's `onStopping` hooks, keep serving for `delayMs`, stop accepting connections, let
   * in-flight requests finish for up to `drainMs`, then close what is left and run `onStop`.
   */
  stop(options?: NodeStopOptions): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

const DEFAULT_DRAIN_MS = 10_000
const DRAIN_POLL_MS = 10

const UNSUPPORTED = ["static", "fastResponse"] as const

type RouteHandler = (res: HttpResponse, req: HttpRequest) => void

/** uWS's precompiled reply: written by the C++ side with no callback into JS. Not in the package's typings. */
interface DeclarativeBuilder {
  writeStatus(status: string): DeclarativeBuilder
  writeHeader(name: string, value: string): DeclarativeBuilder
  /** The value of the route's named `:parameter`, as sent. */
  writeParameterValue(name: string): DeclarativeBuilder
  /** Seals the reply; what comes back is the route handler. */
  end(body?: string): RouteHandler
}

export function serve(app: FetchHandler, options: ServeOptions): Promise<UwsServer> {
  for (const name of UNSUPPORTED) {
    if (name in options) {
      throw new TypeError(
        `@nifrajs/node-uws: \`${name}\` is not supported; serve files from a route or put a static host in front`,
      )
    }
  }
  if (typeof options.port !== "number" || !Number.isInteger(options.port) || options.port < 0) {
    throw new TypeError("@nifrajs/node-uws: `port` must be a non-negative integer")
  }
  const policy = hostPolicyOf(options)
  const protocol = options.protocol ?? (options.tls === undefined ? "http" : "https")
  if (protocol !== "http" && protocol !== "https") {
    throw new TypeError(`@nifrajs/node-uws: protocol must be "http" or "https"`)
  }

  const uWS = loadUws()
  activateAsyncContextFrame()
  enableNodeDirect(app)
  const report = errorReporterOf(app)
  const lifecycle = lifecycleOf(app)
  const resolveNodeSource = app.resolveNodeSource

  let inFlight = 0
  let closed = false

  const finish = (source: UwsSource): void => {
    if (source.settled) return
    source.settled = true
    source.channel?.close()
    source.release()
    inFlight -= 1
  }

  const fail = (res: HttpResponse, source: UwsSource, error: unknown): void => {
    try {
      report?.(error)
    } catch {
      // A logger that throws must not keep the 500 from going out.
    }
    try {
      source.channel?.unthrottle()
      writeFailure(res, source)
    } catch {
      // The connection went away between the failure and the write.
    }
    finish(source)
  }

  // uWS wants an abort handler on any response that outlives the route callback, and none on one that
  // ends inside it: a synchronous answer skips the registration (a native call and a closure).
  const watch = (res: HttpResponse, source: UwsSource): void => {
    res.onAborted(() => {
      source.abort()
      finish(source)
    })
  }

  const answer = (
    res: HttpResponse,
    source: UwsSource,
    outcome: NodeServeOutcome | Promise<NodeServeOutcome>,
    isHead: boolean,
  ): void => {
    if (outcome instanceof Promise) {
      source.detach()
      watch(res, source)
      outcome.then(
        (settled) => {
          if (source.aborted) return
          try {
            source.channel?.unthrottle()
            const written = writeOutcome(res, source, settled, isHead, false)
            if (written instanceof Promise) {
              written.then(
                () => finish(source),
                (error: unknown) => fail(res, source, error),
              )
              return
            }
            finish(source)
          } catch (error) {
            fail(res, source, error)
          }
        },
        (error: unknown) => {
          if (!source.aborted) fail(res, source, error)
        },
      )
      return
    }
    try {
      source.channel?.unthrottle()
      // uWS corks a response written from the handler's own synchronous part; a write after an
      // `await` is the one that needs `cork`.
      const written = writeOutcome(res, source, outcome, isHead, true)
      if (written instanceof Promise) {
        source.detach()
        watch(res, source)
        written.then(
          () => finish(source),
          (error: unknown) => fail(res, source, error),
        )
        return
      }
      finish(source)
    } catch (error) {
      fail(res, source, error)
    }
  }

  const refuse = (res: HttpResponse): void => {
    res.cork(() => {
      res.writeStatus("400 Bad Request")
      res.writeHeader("content-type", "text/plain; charset=utf-8")
      res.end("Bad Request")
    })
  }

  const app$ = options.tls === undefined ? uWS.App() : uWS.SSLApp(sslOptions(options.tls))

  const handle = (method: string | undefined) => (res: HttpResponse, req: HttpRequest) => {
    const authority = resolveRequestHost(req.getHeader("host") || undefined, policy)
    if (authority === undefined) {
      refuse(res)
      return
    }
    const verb = method ?? req.getCaseSensitiveMethod().toUpperCase()
    let target = req.getUrl()
    const query = req.getQuery()
    if (query !== undefined) target = `${target}?${query}`
    target = resolveRequestTarget(target, policy.normalizeTarget)

    inFlight += 1
    const source = new UwsSource(verb, target, authority, protocol, req, res)
    let outcome: NodeServeOutcome | Promise<NodeServeOutcome>
    try {
      if (resolveNodeSource === undefined) {
        outcome = Promise.resolve(app.fetch(source.request, source)).then((response) => ({
          kind: "response",
          response,
        }))
      } else {
        outcome = resolveNodeSource.call(app, source, source, nodeOutcomeRuntime)
      }
    } catch (error) {
      fail(res, source, error)
      return
    }
    answer(res, source, outcome, verb === "HEAD")
  }

  registerDeclarative(app$, uWS, app, policy, handle)

  // One route per common method: uWS has already matched the verb, so none of them reads it back
  // across the native boundary. `any` catches the rest (QUERY, PROPFIND, ...).
  app$
    .get("/*", handle("GET"))
    .post("/*", handle("POST"))
    .put("/*", handle("PUT"))
    .del("/*", handle("DELETE"))
    .patch("/*", handle("PATCH"))
    .head("/*", handle("HEAD"))
    .options("/*", handle("OPTIONS"))
    .any("/*", handle(undefined))

  // A WebSocket handshake never reaches the route above: uWS hands it to this one, and nothing here
  // serves sockets, so it is refused instead of being answered as a plain GET.
  app$.ws("/*", {
    upgrade: (res: HttpResponse) => {
      res.cork(() => {
        res.writeStatus("501 Not Implemented")
        res.writeHeader("content-type", "application/json")
        res.end('{"ok":false,"error":"websocket_unsupported"}')
      })
    },
    message: () => {},
  })

  const signals = options.gracefulSignals === true ? {} : options.gracefulSignals || undefined
  const onSignal = (): void => {
    void stop(signals)
  }

  let shutdown: Promise<void> | undefined
  let token: ListenSocket | undefined
  function stop(stopOptions: NodeStopOptions = {}): Promise<void> {
    shutdown ??= stopOnce(stopOptions)
    return shutdown
  }
  async function stopOnce({
    drainMs = DEFAULT_DRAIN_MS,
    delayMs = 0,
  }: NodeStopOptions): Promise<void> {
    if (closed) return
    closed = true
    if (signals !== undefined) {
      process.removeListener("SIGTERM", onSignal)
      process.removeListener("SIGINT", onSignal)
    }
    try {
      await lifecycle("stopping")
    } catch (error) {
      // A failed hook must not leave the listener accepting after `closed` has made a retry a no-op.
      if (token !== undefined) uWS.us_listen_socket_close(token)
      app$.close()
      throw error
    }
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
    if (token !== undefined) uWS.us_listen_socket_close(token)
    const deadline = Date.now() + drainMs
    while (inFlight > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS))
    }
    // Closes what the drain left: stragglers, idle keep-alive connections.
    app$.close()
    await lifecycle("stopped")
  }

  return new Promise((resolve, reject) => {
    const onListen = (listening: ListenSocket | false): void => {
      if (listening === false) {
        reject(new Error(`@nifrajs/node-uws: cannot listen on port ${options.port}`))
        return
      }
      token = listening
      if (signals !== undefined) {
        process.once("SIGTERM", onSignal)
        process.once("SIGINT", onSignal)
      }
      resolve({
        port: uWS.us_socket_local_port(listening),
        stop,
        [Symbol.asyncDispose]: () => shutdown ?? stop(),
      })
    }
    if (options.hostname === undefined) app$.listen(options.port, onListen)
    else app$.listen(options.hostname, options.port, onListen)
  })
}

/**
 * Fixed replies (`staticResponse()` routes) are compiled into uWS and answered without entering JS. The
 * app is sealed by asking, as `listen()` seals it, so no hook or route added later can be skipped. A
 * Host policy needs every request's Host read, so it keeps these routes on the ordinary path; so does a
 * malformed Host, which is only screened there.
 */
function registerDeclarative(
  app$: TemplatedApp,
  uWS: Uws,
  app: FetchHandler,
  policy: ReturnType<typeof hostPolicyOf>,
  ordinary: (method: string) => RouteHandler,
): void {
  if (!isServerView(app)) return
  const routes = declarativeRoutes(app)
  if (
    policy.allowedHosts !== undefined ||
    policy.canonicalHost !== undefined ||
    policy.normalizeTarget
  ) {
    return
  }
  // uWS exports this class; its typings omit it.
  const Declarative: unknown = Reflect.get(uWS, "DeclarativeResponse")
  if (typeof Declarative !== "function") return
  for (const route of routes) {
    // uWS refuses a precompiled header name or value over 255 bytes; such a route stays with the router.
    if (route.headers.some((pair) => pair.some((text) => Buffer.byteLength(text) > 255))) continue
    if (route.method === "POST") {
      registerFixedPost(app$, route, ordinary("POST"))
      continue
    }
    const reply: DeclarativeBuilder = Reflect.construct(Declarative, [])
    reply.writeStatus(statusLine(route.status))
    for (const [name, value] of route.headers) reply.writeHeader(name, value)
    if (route.param !== undefined) reply.writeParameterValue(route.param)
    app$.get(route.path, reply.end())
  }
}

/**
 * A fixed POST is not a precompiled reply: every bodyless POST runs the cross-site form check, which
 * refuses a request only when it carries an `Origin` header (a browser always sends one; a script or a
 * load generator does not). A request with one goes to the ordinary path, which runs the check; one
 * without is answered here, from uWS's callback, without building a request. The body is left unread,
 * as the ordinary path leaves it for a route with no body schema.
 */
function registerFixedPost(
  app$: TemplatedApp,
  route: DeclarativeRoute,
  ordinary: RouteHandler,
): void {
  const line = statusLine(route.status)
  const headers = route.headers
  app$.post(route.path, (res, req) => {
    if (req.getHeader("origin") !== "") {
      ordinary(res, req)
      return
    }
    res.cork(() => {
      res.writeStatus(line)
      for (const [name, value] of headers) res.writeHeader(name, value)
      res.end()
    })
  })
}

function sslOptions(tls: UwsTlsOptions): AppOptions {
  const options: AppOptions = { key_file_name: tls.keyFileName, cert_file_name: tls.certFileName }
  if (tls.passphrase !== undefined) options.passphrase = tls.passphrase
  if (tls.caFileName !== undefined) options.ca_file_name = tls.caFileName
  if (tls.dhParamsFileName !== undefined) options.dh_params_file_name = tls.dhParamsFileName
  if (tls.sslCiphers !== undefined) options.ssl_ciphers = tls.sslCiphers
  if (tls.sslPreferLowMemoryUsage !== undefined) {
    options.ssl_prefer_low_memory_usage = tls.sslPreferLowMemoryUsage
  }
  return options
}
