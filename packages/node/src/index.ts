/**
 * Run a nifra app (or any Web-`fetch` handler) on Node's `http` server.
 *
 *   import { serve } from "@nifrajs/node"
 *   import { server } from "@nifrajs/core"
 *   const app = server().get("/", () => ({ ok: true }))
 *   serve(app, { port: 3000 })
 *
 * nifra's lifecycle is `app.fetch(Request): Response | Promise<Response>` — pure Web Standards —
 * so this adapter just bridges Node's stream-based `(req, res)` to/from Web
 * `Request`/`Response`, plus a Bun-`listen()`-style graceful `stop()`.
 */
import { open, realpath } from "node:fs/promises"
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import { extname, resolve, sep } from "node:path"
import { type Duplex, Readable } from "node:stream"
import { fileURLToPath } from "node:url"

/** Anything exposing a Web `fetch` handler — a nifra `app`, for instance. */
export interface FetchHandler {
  fetch(request: Request): Response | Promise<Response>
  /** Nifra apps also expose this WS-upgrade seam; present → this adapter serves `app.ws()` routes via
   * the optional `ws` package (lazy-imported on the first upgrade). Absent (a plain `{ fetch }`
   * handler) → HTTP only, and an upgrade request gets a 404. */
  resolveWebSocketUpgrade?(request: Request): WsUpgradeOutcome | Promise<WsUpgradeOutcome>
}

// --- WebSocket types: structurally mirrored from @nifrajs/core (this adapter has no @nifrajs/core
// dependency — see NodeServeOutcome above). Kept in lockstep by the WS integration test. ---

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

/** Mirror of core's `TopicRegistry` surface — the app's pub/sub the adapter wires `ws.subscribe` to. */
interface WsPubSub {
  subscribe(topic: string, ws: NifraWs): void
  unsubscribe(topic: string, ws: NifraWs): void
  unsubscribeAll(ws: NifraWs): void
}

/** A nifra WS route's lifecycle (mirror of core's `WebSocketHandler` — the post-upgrade callbacks). */
interface NifraWsHandler {
  open?(ws: NifraWs): void | Promise<void>
  message?(ws: NifraWs, data: NifraWsData): void | Promise<void>
  close?(ws: NifraWs, code: number, reason: string): void | Promise<void>
  error?(ws: NifraWs, error: unknown): void | Promise<void>
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

/** Structural view of the `ws` package's `WebSocket` (no `@types/ws` dependency — see `loadWsServer`). */
interface WsSocket {
  send(data: string | ArrayBufferView | ArrayBuffer): void
  close(code?: number, reason?: string): void
  readonly readyState: number
  on(event: "message", listener: (data: Buffer, isBinary: boolean) => void): void
  on(event: "close", listener: (code: number, reason: Buffer) => void): void
  on(event: "error", listener: (error: Error) => void): void
}

/** Structural view of the `ws` package's `WebSocketServer` (noServer mode). */
interface WsServer {
  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (ws: WsSocket) => void,
  ): void
}

export type RequestProtocol = "http" | "https"
export type RequestProtocolOption =
  | RequestProtocol
  | ((request: IncomingMessage) => RequestProtocol)
type RequestProtocolResolver = (request: IncomingMessage) => RequestProtocol

/**
 * The node-direct render returned by a nifra app's `resolveNode` — structurally mirrored here so this
 * adapter stays decoupled from `@nifrajs/core` (it bridges *any* handler exposing this seam, and has no
 * runtime dependency on nifra). A `kind: "json"` outcome is a plain-data result we serialize straight to
 * the socket; a `kind: "body"` outcome is a marked buffered response body (notably @nifrajs/web's
 * non-deferred SSR HTML). Both skip undici/Web body draining. Everything else carries a `Response` we
 * write the usual Web way. Kept in lockstep with `@nifrajs/core`'s `NodeServeOutcome` by the integration
 * test (`serve.test.ts`), which runs a real nifra app end-to-end through this path.
 */
type NodeServeOutcome =
  | { readonly kind: "response"; readonly response: Response }
  | {
      readonly kind: "json"
      readonly status: number
      readonly headers: Readonly<Record<string, string>> | undefined
      readonly cookies: readonly string[] | undefined
      readonly body: string | null
    }
  | {
      readonly kind: "body"
      readonly status: number
      readonly headers: Readonly<Record<string, string | readonly string[]>> | undefined
      readonly body: string | Uint8Array
    }

interface NodeRequestSource {
  readonly method: string
  readonly url: string
  readonly headers: Headers
  header(name: string): string | null
  readonly body: ReadableStream<Uint8Array> | null
  arrayBuffer(): Promise<ArrayBuffer>
  json(): Promise<unknown>
  readonly request: Request
}

/** A `FetchHandler` that *also* exposes the node-direct fast path (every nifra app does). May resolve
 * **synchronously** (a bare route + sync handler allocates no promise) — we `await` it regardless. */
interface NodeFastHandler extends FetchHandler {
  resolveNode(request: Request): NodeServeOutcome | Promise<NodeServeOutcome>
  resolveNodeSource(source: NodeRequestSource): NodeServeOutcome | Promise<NodeServeOutcome>
}

/**
 * The `Content-Type` the host runtime's `Response.json` emits — Node's undici uses `application/json`,
 * Bun uses `application/json;charset=utf-8`. Probed once at module load (zero per-request cost) so the
 * fast path is byte-for-byte identical to the `Response`-building path on whatever runtime hosts us.
 */
const JSON_CONTENT_TYPE = Response.json(0).headers.get("content-type") ?? "application/json"

const INTERNAL_ERROR_BODY = '{"ok":false,"error":"internal_error"}'
const EMPTY_BUFFER = Buffer.alloc(0)
const NODE_RESPONSE_BODY = Symbol.for("nifra.response.body")

/**
 * Serve static files from a directory (e.g. the client build) under a URL prefix — so a self-hosted
 * Node deploy doesn't need a CDN or a hand-rolled `/assets/*` handler. (On Cloudflare/Vercel the
 * platform serves assets; this is for `node server.js`.)
 */
export interface ServeStaticOptions {
  /** Directory to read files from — an absolute path or a `file://` URL (`new URL("./assets/", import.meta.url)`). */
  readonly dir: string | URL
  /** URL prefix these files are served under. Default `"/assets"`. Use `"/"` to serve the whole dir. */
  readonly prefix?: string
  /** Emit `cache-control: public, max-age=31536000, immutable` — correct for content-hashed files. Default `true`. */
  readonly immutable?: boolean
  /** Extra headers merged onto every served file. */
  readonly headers?: Readonly<Record<string, string>>
}

export interface ServeOptions {
  readonly port: number
  readonly hostname?: string
  /**
   * Protocol used when the adapter constructs `Request.url`.
   *
   * `@nifrajs/node` creates a plain Node `http` server, so the safe default is `"http"`. Deployments behind
   * TLS termination can set `"https"` (or a trusted infra-aware function) so app code that reads
   * `request.url` sees the public scheme. Forwarded headers are not trusted implicitly.
   */
  readonly protocol?: RequestProtocolOption
  /**
   * Install SIGTERM/SIGINT handlers that call `stop()` for a graceful drain on
   * `docker stop` / Ctrl-C. Off by default — taking over process signals is opt-in,
   * mirroring nifra's Bun `listen({ gracefulSignals })`.
   *
   * The app-level request timeout (`server({ requestTimeoutMs })` → 503) and body cap
   * are *not* set here — they live inside `app.fetch`, so they already apply through
   * this adapter. Slow-client protection is Node's built-in `requestTimeout` (300s) /
   * `headersTimeout` (60s) defaults.
   */
  readonly signals?: boolean
  /**
   * Serve static files from disk for matching GET/HEAD requests *before* the app runs — non-matching
   * requests fall through to `app.fetch` with the node-direct fast path intact (no perf regression on
   * SSR/API routes). Replaces the hand-rolled `/assets/*` reader in self-hosted entries.
   */
  readonly static?: ServeStaticOptions
}

export interface NodeServer {
  /** The bound port (resolved when `port: 0` is requested). */
  readonly port: number
  /**
   * Stop accepting connections, let in-flight requests drain (up to `drainMs`), then
   * force-close stragglers + idle keep-alives. Mirrors nifra's Bun `stop()`.
   */
  stop(options?: { drainMs?: number }): Promise<void>
}

const DEFAULT_DRAIN_MS = 10_000
const DRAIN_POLL_MS = 10

const STATIC_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
}

interface StaticState {
  readonly root: string
  readonly prefix: string // normalized: "/assets" (no trailing slash) or "/"
  readonly immutable: boolean
  readonly headers: Readonly<Record<string, string>> | undefined
}

function staticStateOf(options: ServeStaticOptions): StaticState {
  const root = resolve(typeof options.dir === "string" ? options.dir : fileURLToPath(options.dir))
  const raw = options.prefix ?? "/assets"
  const prefix = raw === "/" ? "/" : `/${raw.replace(/^\/+|\/+$/g, "")}`
  return { root, prefix, immutable: options.immutable !== false, headers: options.headers }
}

/**
 * Resolve a request URL to a file under the served root — **synchronously**, so non-matching requests
 * stay on the app's sync fast path. Returns `"pass"` (let the app handle it), a rejection `Response`
 * (malformed encoding / NUL / `..` traversal out of root), or a confined absolute file path to read.
 */
function staticMatch(
  state: StaticState,
  rawUrl: string,
): "pass" | { readonly reject: Response } | { readonly file: string } {
  const query = rawUrl.indexOf("?")
  const path = query === -1 ? rawUrl : rawUrl.slice(0, query)
  const underPrefix =
    state.prefix === "/" ? true : path === state.prefix || path.startsWith(`${state.prefix}/`)
  if (!underPrefix) return "pass"
  let rel: string
  try {
    rel = decodeURIComponent(state.prefix === "/" ? path : path.slice(state.prefix.length))
  } catch {
    return { reject: new Response("Bad Request", { status: 400 }) }
  }
  rel = rel.replace(/^\/+/, "")
  if (rel === "" || rel.endsWith("/")) return "pass" // a directory request → the app decides
  if (rel.includes("\0")) return { reject: new Response("Bad Request", { status: 400 }) }
  const file = resolve(state.root, rel)
  // Confine to the served directory — block `..` from escaping root.
  if (file !== state.root && !file.startsWith(state.root + sep)) {
    return { reject: new Response("Forbidden", { status: 403 }) }
  }
  return { file }
}

async function readStatic(
  file: string,
  state: StaticState,
  method: string,
): Promise<NodeServeOutcome> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(file, "r")
    const stat = await handle.stat()
    if (!stat.isFile()) {
      await handle.close()
      return { kind: "response", response: new Response("Not Found", { status: 404 }) }
    }
    // Defense-in-depth: the lexical `..` guard in staticMatch can't catch a symlink INSIDE root that
    // points outside it. Re-confirm the real path is contained before streaming the bytes.
    const [realFile, realRoot] = await Promise.all([realpath(file), realpath(state.root)])
    if (realFile !== realRoot && !realFile.startsWith(realRoot + sep)) {
      await handle.close()
      return { kind: "response", response: new Response("Forbidden", { status: 403 }) }
    }
    const headers: Record<string, string> = { ...state.headers }
    headers["content-type"] =
      STATIC_CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream"
    // Never let a client sniff a served file into a more dangerous type (e.g. an .svg as active content).
    headers["x-content-type-options"] = "nosniff"
    headers["content-length"] = String(stat.size)
    if (state.immutable && headers["cache-control"] === undefined) {
      headers["cache-control"] = "public, max-age=31536000, immutable"
    }
    if (method === "HEAD") {
      await handle.close()
      return { kind: "response", response: new Response(null, { headers }) }
    }
    const stream = handle.createReadStream()
    return {
      kind: "response",
      response: new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { headers }),
    }
  } catch {
    await handle?.close().catch(() => {})
    // Missing/unreadable under the static prefix → 404 (don't fall through to an SSR 404 page).
    return { kind: "response", response: new Response("Not Found", { status: 404 }) }
  }
}

/**
 * Serve a Web-`fetch` app on a Node `http` server. Resolves once bound — Node binds
 * the port asynchronously, so awaiting gives you the real port (matters for `port: 0`).
 */
export function serve(app: FetchHandler, options: ServeOptions): Promise<NodeServer> {
  let inFlight = 0
  let closed = false
  const protocol = protocolResolver(options.protocol)
  const staticState = options.static !== undefined ? staticStateOf(options.static) : undefined
  const server = createServer((nodeReq, nodeRes) => {
    inFlight += 1
    try {
      const handled = handle(app, nodeReq, nodeRes, protocol, staticState)
      if (handled instanceof Promise) {
        void handled.finally(() => {
          inFlight -= 1
        })
        return
      }
      inFlight -= 1
    } catch {
      writeInternalError(nodeRes)
      inFlight -= 1
    }
  })

  // WebSocket upgrades (a nifra app exposing the seam): handled on the http server's `upgrade` event via
  // the optional `ws` package — lazy-imported (and the server lazily built) on the FIRST real WS
  // upgrade, so a non-WS Node app never loads `ws`.
  const resolveWs = app.resolveWebSocketUpgrade?.bind(app)
  if (resolveWs !== undefined) {
    let wssPromise: Promise<WsServer | undefined> | undefined
    server.on("upgrade", (nodeReq, socket, head) => {
      void handleUpgrade(resolveWs, protocol, nodeReq, socket, head, () => {
        wssPromise ??= loadWsServer()
        return wssPromise
      })
    })
  }

  // Opt-in: own SIGTERM/SIGINT so `docker stop` / Ctrl-C drains in-flight requests
  // before exit. `stop` is hoisted, so `onSignal` can reference it.
  const onSignal = (): void => {
    void stop()
  }

  async function stop({ drainMs = DEFAULT_DRAIN_MS }: { drainMs?: number } = {}): Promise<void> {
    if (closed) return // idempotent
    closed = true
    if (options.signals === true) {
      // Remove our own handlers so repeated serve()/stop() cycles don't leak listeners.
      process.removeListener("SIGTERM", onSignal)
      process.removeListener("SIGINT", onSignal)
    }
    server.close() // stop accepting new connections; existing requests continue
    const deadline = Date.now() + drainMs
    while (inFlight > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, DRAIN_POLL_MS))
    }
    server.closeAllConnections() // force-close stragglers + idle keep-alive sockets
  }

  return new Promise((resolve) => {
    server.listen(options.port, options.hostname, () => {
      const address = server.address()
      const port = address !== null && typeof address === "object" ? address.port : options.port
      if (options.signals === true) {
        process.once("SIGTERM", onSignal)
        process.once("SIGINT", onSignal)
      }
      resolve({ port, stop })
    })
  })
}

function handle(
  app: FetchHandler,
  nodeReq: IncomingMessage,
  nodeRes: ServerResponse,
  getProtocol: RequestProtocolResolver,
  staticState: StaticState | undefined,
): void | Promise<void> {
  let protocol: RequestProtocol
  try {
    protocol = getProtocol(nodeReq)
  } catch {
    writeInternalError(nodeRes)
    return
  }

  // Static files first (GET/HEAD). The match is synchronous, so a non-asset request never leaves the
  // app's sync fast path below; only a prefix hit reads from disk (and async-writes the file).
  if (staticState !== undefined && (nodeReq.method === "GET" || nodeReq.method === "HEAD")) {
    const matched = staticMatch(staticState, nodeReq.url ?? "/")
    if (matched !== "pass") {
      if ("reject" in matched) return writeNodeResponse(matched.reject, nodeRes)
      return readStatic(matched.file, staticState, nodeReq.method ?? "GET").then(
        (outcome) => writeNodeOutcome(outcome, nodeRes),
        () => writeInternalError(nodeRes),
      )
    }
  }

  // Fast path: a nifra app exposes `resolveNode`, which renders a plain-data result as primitives we
  // write straight to the socket — skipping the undici `Response` build + body drain (the bulk of the
  // Web-bridge cost on Node). A handler-returned `Response`/redirect, 404/405, error, timeout, or any
  // `onResponse` hook comes back as `{ kind: "response" }` and takes the same Web path as before, so
  // behavior is identical. A plain `{ fetch }` handler (no `resolveNode`) uses the Web path too.
  const resolveNodeSource = (app as Partial<NodeFastHandler>).resolveNodeSource
  if (typeof resolveNodeSource === "function") {
    try {
      const outcome = resolveNodeSource.call(app, toNodeRequestSource(nodeReq, protocol))
      return outcome instanceof Promise
        ? outcome.then(
            (settled) => writeNodeOutcome(settled, nodeRes),
            () => writeInternalError(nodeRes),
          )
        : writeNodeOutcome(outcome, nodeRes)
    } catch {
      writeInternalError(nodeRes)
      return
    }
  }

  const request = toWebRequest(nodeReq, protocol)
  const resolveNode = (app as Partial<NodeFastHandler>).resolveNode
  if (typeof resolveNode === "function") {
    try {
      const outcome = resolveNode.call(app, request)
      return outcome instanceof Promise
        ? outcome.then(
            (settled) => writeNodeOutcome(settled, nodeRes),
            () => writeInternalError(nodeRes),
          )
        : writeNodeOutcome(outcome, nodeRes)
    } catch {
      writeInternalError(nodeRes)
      return
    }
  }

  try {
    const response = app.fetch(request)
    return response instanceof Promise
      ? response.then(
          (settled) => writeNodeResponse(settled, nodeRes),
          () => writeInternalError(nodeRes),
        )
      : writeNodeResponse(response, nodeRes)
  } catch {
    // The app should never throw (nifra returns a 500), but never leak a stack to the wire.
    writeInternalError(nodeRes)
    return
  }
}

function writeNodeOutcome(
  outcome: NodeServeOutcome,
  nodeRes: ServerResponse,
): void | Promise<void> {
  if (outcome.kind === "json") {
    writeJsonOutcome(outcome, nodeRes)
    return
  }
  if (outcome.kind === "body") {
    writeBodyOutcome(outcome, nodeRes)
    return
  }
  return writeNodeResponse(outcome.response, nodeRes)
}

/** A flat 500 with no leaked detail — the adapter's last-resort guard if a handler throws. */
function writeInternalError(nodeRes: ServerResponse): void {
  nodeRes.writeHead(500, { "content-type": "application/json" })
  nodeRes.end(INTERNAL_ERROR_BODY)
}

/**
 * Serialize a node-direct JSON outcome straight to the socket — no undici `Response`, no stream drain.
 * Mirrors `Response.json(data, { status, headers })` byte-for-byte: user headers are lowercased to
 * match undici's `Headers` normalization, the JSON `Content-Type` matches the host runtime's, and each
 * queued cookie is emitted as its own `Set-Cookie` line (never comma-joined).
 */
function writeJsonOutcome(
  outcome: Extract<NodeServeOutcome, { kind: "json" }>,
  nodeRes: ServerResponse,
): void {
  const headers: Record<string, string | string[]> = {}
  if (outcome.headers !== undefined) {
    for (const [key, value] of Object.entries(outcome.headers)) headers[key.toLowerCase()] = value
  }
  // A `null` body is a 204/no-content render — `new Response(null)` carries no Content-Type, so we add
  // none either; a non-null body is JSON, matching `Response.json`'s Content-Type.
  if (outcome.body !== null) headers["content-type"] = JSON_CONTENT_TYPE
  if (outcome.cookies !== undefined && outcome.cookies.length > 0) {
    headers["set-cookie"] = [...outcome.cookies]
  }
  nodeRes.writeHead(outcome.status, headers)
  if (outcome.body !== null) nodeRes.end(outcome.body)
  else nodeRes.end()
}

/**
 * Write a node-direct buffered body outcome straight to the socket. This is the Response-shaped
 * sibling of `writeJsonOutcome`: headers/status were already normalized by core, and the body is the
 * exact marked payload from the Response producer, so there is no Web body reader to drain.
 */
function writeBodyOutcome(
  outcome: Extract<NodeServeOutcome, { kind: "body" }>,
  nodeRes: ServerResponse,
): void {
  const headers: Record<string, string | string[]> = {}
  if (outcome.headers !== undefined) {
    for (const [key, value] of Object.entries(outcome.headers)) {
      headers[key] = typeof value === "string" ? value : [...value]
    }
  }
  nodeRes.writeHead(outcome.status, headers)
  nodeRes.end(outcome.body)
}

function protocolResolver(option: RequestProtocolOption | undefined): RequestProtocolResolver {
  if (option === undefined) return () => "http"
  if (typeof option === "function") return (req) => normalizeProtocol(option(req))
  const protocol = normalizeProtocol(option)
  return () => protocol
}

function normalizeProtocol(value: string): RequestProtocol {
  if (value === "http" || value === "https") return value
  throw new Error(
    `@nifrajs/node: protocol must be "http" or "https" (got ${JSON.stringify(value)})`,
  )
}

function toWebRequest(req: IncomingMessage, protocol: RequestProtocol): Request {
  const host = req.headers.host ?? "localhost"
  const url = `${protocol}://${host}${req.url ?? "/"}`
  const method = req.method ?? "GET"
  return makeWebRequest(req, method, url, headersFromNode(req.headers))
}

function toNodeRequestSource(req: IncomingMessage, protocol: RequestProtocol): NodeRequestSource {
  return new LazyNodeRequestSource(req, protocol)
}

/**
 * Lazy view over a Node `IncomingMessage`. Methods live on the prototype (not re-allocated per
 * request), and every materialization is deferred: the `Headers` object, the Web `ReadableStream`
 * body, and the undici `Request` are each built only when first read. A bare GET that never touches
 * `c.req` allocates just this instance.
 */
class LazyNodeRequestSource implements NodeRequestSource {
  readonly method: string
  readonly url: string

  private headersValue: Headers | undefined
  private bodyValue: ReadableStream<Uint8Array> | null | undefined
  private requestValue: Request | undefined
  private consumedBody: Buffer | undefined
  private readBodyPromise: Promise<Buffer> | undefined
  private readonly nodeReq: IncomingMessage

  constructor(nodeReq: IncomingMessage, protocol: RequestProtocol) {
    this.nodeReq = nodeReq
    this.method = nodeReq.method ?? "GET"
    const host = nodeReq.headers.host ?? "localhost"
    this.url = `${protocol}://${host}${nodeReq.url ?? "/"}`
  }

  get headers(): Headers {
    this.headersValue ??= headersFromNode(this.nodeReq.headers)
    return this.headersValue
  }

  // Read straight off Node's already-lowercased header bag (comma-joining multi-values to match
  // `Headers.get`) so the body-cap path can check content-type/length without building a `Headers`.
  header(name: string): string | null {
    const value = this.nodeReq.headers[name.toLowerCase()]
    if (value === undefined) return null
    return Array.isArray(value) ? value.join(", ") : value
  }

  get body(): ReadableStream<Uint8Array> | null {
    if (this.method === "GET" || this.method === "HEAD") return null
    if (this.consumedBody !== undefined) return this.request.body
    this.bodyValue ??= Readable.toWeb(this.nodeReq) as ReadableStream<Uint8Array>
    return this.bodyValue
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    if (this.requestValue !== undefined) return this.requestValue.arrayBuffer()
    return this.readNodeBody().then(
      (buffer) =>
        buffer.buffer.slice(
          buffer.byteOffset,
          buffer.byteOffset + buffer.byteLength,
        ) as ArrayBuffer,
    )
  }

  json(): Promise<unknown> {
    if (this.requestValue !== undefined) return this.requestValue.json()
    return this.readNodeBody().then((buffer) => JSON.parse(buffer.toString("utf8")) as unknown)
  }

  get request(): Request {
    if (this.requestValue !== undefined) return this.requestValue
    if (this.consumedBody !== undefined) {
      this.requestValue = makeWebRequest(
        this.nodeReq,
        this.method,
        this.url,
        this.headers,
        this.consumedBody,
      )
      // Preserve one-shot body semantics if user code asks for `c.req` after nifra already consumed it.
      void this.requestValue.arrayBuffer().catch(() => {})
      return this.requestValue
    }
    this.requestValue = makeWebRequest(this.nodeReq, this.method, this.url, this.headers, this.body)
    return this.requestValue
  }

  // Buffer the request body once. A single-chunk body (the common case) skips the array + `concat`;
  // a client abort / socket error rejects (via `error`/`aborted`), which the body-cap callers catch
  // and map to a flat 400.
  private readNodeBody(): Promise<Buffer> {
    if (this.consumedBody !== undefined) return Promise.resolve(this.consumedBody)
    this.readBodyPromise ??= new Promise<Buffer>((resolve, reject) => {
      let first: Buffer | undefined
      let chunks: Buffer[] | undefined
      let total = 0
      const finish = (): void => {
        cleanup()
        this.consumedBody =
          chunks === undefined ? (first ?? EMPTY_BUFFER) : Buffer.concat(chunks, total)
        resolve(this.consumedBody)
      }
      const fail = (err: Error): void => {
        cleanup()
        reject(err)
      }
      const onData = (chunk: Buffer | string): void => {
        const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk
        if (first === undefined) {
          first = buffer
        } else {
          chunks ??= [first]
          chunks.push(buffer)
        }
        total += buffer.byteLength
      }
      const onAborted = (): void => fail(new Error("request aborted"))
      const cleanup = (): void => {
        this.nodeReq.removeListener("data", onData)
        this.nodeReq.removeListener("end", finish)
        this.nodeReq.removeListener("error", fail)
        this.nodeReq.removeListener("aborted", onAborted)
        this.nodeReq.removeListener("close", onClose)
      }
      // `aborted` is deprecated on newer Node; `close`-without-`end` is the forward-compatible signal
      // that the connection dropped mid-body. Either way the read rejects instead of hanging forever.
      const onClose = (): void => {
        if (this.consumedBody === undefined) fail(new Error("request closed before body completed"))
      }
      this.nodeReq.on("data", onData)
      this.nodeReq.once("end", finish)
      this.nodeReq.once("error", fail)
      this.nodeReq.once("aborted", onAborted)
      this.nodeReq.once("close", onClose)
    })
    return this.readBodyPromise
  }
}

function headersFromNode(input: IncomingHttpHeaders): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue
    headers.set(key, Array.isArray(value) ? value.join(", ") : value)
  }
  return headers
}

function makeWebRequest(
  req: IncomingMessage,
  method: string,
  url: string,
  headers: Headers,
  body?: ReadableStream<Uint8Array> | Uint8Array | null,
): Request {
  const init: RequestInit & { duplex?: "half" } = { method, headers }
  if (method !== "GET" && method !== "HEAD") {
    // Stream the body in; `duplex: "half"` is required for a streamed request body.
    init.body = body ?? (Readable.toWeb(req) as ReadableStream<Uint8Array>)
    init.duplex = "half"
  }
  return new Request(url, init)
}

function waitForDrain(nodeRes: ServerResponse): Promise<boolean> {
  if (nodeRes.destroyed || nodeRes.writableEnded || !nodeRes.writable) {
    return Promise.resolve(false)
  }
  return new Promise((resolve) => {
    const cleanup = (): void => {
      nodeRes.removeListener("drain", onDrain)
      nodeRes.removeListener("close", onClose)
      nodeRes.removeListener("error", onError)
    }
    const onDrain = (): void => {
      cleanup()
      resolve(true)
    }
    const onClose = (): void => {
      cleanup()
      resolve(false)
    }
    const onError = (): void => {
      cleanup()
      resolve(false)
    }
    nodeRes.once("drain", onDrain)
    nodeRes.once("close", onClose)
    nodeRes.once("error", onError)
    if (nodeRes.destroyed || nodeRes.writableEnded || !nodeRes.writable) {
      cleanup()
      resolve(false)
    }
  })
}

function writeNodeResponse(response: Response, nodeRes: ServerResponse): void | Promise<void> {
  const headers: Record<string, string | string[]> = {}
  response.headers.forEach((value, key) => {
    headers[key] = value
  })
  // `Headers.forEach` comma-joins repeated `Set-Cookie` into one value — wrong, since a cookie's
  // `Expires` attribute itself contains a comma (so a client can't safely split it back). Emit one
  // header line per cookie via the un-joined `getSetCookie()` array (a response can set several:
  // e.g. a session cookie + a CSRF cookie).
  const setCookies = response.headers.getSetCookie?.()
  if (setCookies !== undefined && setCookies.length > 0) headers["set-cookie"] = setCookies
  nodeRes.writeHead(response.status, headers)
  const directBody = nodeResponseBody(response)
  if (directBody !== undefined) {
    nodeRes.end(directBody)
    return
  }
  if (response.body === null) {
    if (!nodeRes.destroyed && !nodeRes.writableEnded && nodeRes.writable) nodeRes.end()
    return
  }
  return writeNodeResponseBody(response, nodeRes)
}

async function writeNodeResponseBody(response: Response, nodeRes: ServerResponse): Promise<void> {
  const reader = response.body!.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!nodeRes.write(value)) {
        if (nodeRes.destroyed || nodeRes.writableEnded || !nodeRes.writable) {
          try {
            await reader.cancel()
          } catch {}
          return
        }
        const drained = await waitForDrain(nodeRes)
        if (!drained || nodeRes.destroyed || nodeRes.writableEnded || !nodeRes.writable) {
          try {
            await reader.cancel()
          } catch {}
          return
        }
      }
    }
  } catch {
    await reader.cancel().catch(() => {})
    if (!nodeRes.headersSent) writeInternalError(nodeRes)
    else nodeRes.destroy()
    return
  }
  if (!nodeRes.destroyed && !nodeRes.writableEnded && nodeRes.writable) nodeRes.end()
}

function nodeResponseBody(response: Response): string | Uint8Array | undefined {
  if (response.bodyUsed) return undefined
  const body = (response as { readonly [NODE_RESPONSE_BODY]?: unknown })[NODE_RESPONSE_BODY]
  return typeof body === "string" || body instanceof Uint8Array ? body : undefined
}

// --- WebSocket bridge: Node has no built-in WS server, so upgrades go through the OPTIONAL `ws`
// package, lazy-imported on the first upgrade (non-WS apps never load it). ---

type WsServerCtor = new (options: { noServer: true }) => WsServer

/** A non-literal specifier so TS treats `import(...)` as `any` — `ws` is an optional peer with no
 * `@types/ws` dependency here (the surface is structurally typed via {@link WsServer}/{@link WsSocket}). */
const WS_MODULE_SPECIFIER = "ws"

/** Lazily build a noServer `ws` `WebSocketServer`, or `undefined` if `ws` isn't installed. */
async function loadWsServer(): Promise<WsServer | undefined> {
  try {
    const mod = (await import(WS_MODULE_SPECIFIER)) as {
      WebSocketServer?: WsServerCtor
      default?: { WebSocketServer?: WsServerCtor }
    }
    const Ctor = mod.WebSocketServer ?? mod.default?.WebSocketServer
    return Ctor === undefined ? undefined : new Ctor({ noServer: true })
  } catch {
    return undefined // `ws` not installed — caller responds 501
  }
}

const WS_STATUS_TEXT: Readonly<Record<number, string>> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  426: "Upgrade Required",
  500: "Internal Server Error",
  501: "Not Implemented",
}

/** Resolve a Node `upgrade` event: run the nifra upgrade guard, then either reject (write an HTTP error
 * to the raw socket) or perform the `ws` upgrade and wire the socket to the handler. */
async function handleUpgrade(
  resolveWs: (request: Request) => WsUpgradeOutcome | Promise<WsUpgradeOutcome>,
  getProtocol: RequestProtocolResolver,
  nodeReq: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  getWss: () => Promise<WsServer | undefined>,
): Promise<void> {
  let outcome: WsUpgradeOutcome
  try {
    outcome = await resolveWs(toWebRequest(nodeReq, getProtocol(nodeReq)))
  } catch {
    writeUpgradeRejection(socket, 500, "internal_error")
    return
  }
  if (outcome.kind === "pass") {
    writeUpgradeRejection(socket, 404, "not_found") // upgrade to a path with no WS route
    return
  }
  if (outcome.kind === "reject") {
    await writeRejectionResponse(socket, outcome.response)
    return
  }
  const wss = await getWss()
  if (wss === undefined) {
    writeUpgradeRejection(socket, 501, "websocket_unavailable") // `ws` not installed
    return
  }
  const { handler, data, pubsub } = outcome
  wss.handleUpgrade(nodeReq, socket, head, (ws) => attachNodeWebSocket(ws, handler, data, pubsub))
}

/** Wire a `ws` socket (already open in `handleUpgrade`'s callback) to a nifra WS handler. The Node copy
 * of core's `attachWebSocket` — binary frames normalize to `Uint8Array`; a thrown/rejected callback
 * routes to `error()` and never crashes the connection. */
function attachNodeWebSocket(
  ws: WsSocket,
  handler: NifraWsHandler,
  data: unknown,
  pubsub: WsPubSub,
): void {
  const nifra: NifraWs = {
    send: (payload) => ws.send(payload),
    close: (code, reason) => ws.close(code, reason),
    get readyState() {
      return ws.readyState
    },
    subscribe: (topic) => pubsub.subscribe(topic, nifra),
    unsubscribe: (topic) => pubsub.unsubscribe(topic, nifra),
    data,
    raw: ws,
  }
  const reportError = (error: unknown): void => {
    if (handler.error === undefined) return
    try {
      const r = handler.error(nifra, error)
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
  ws.on("message", (raw, isBinary) => {
    const payload: NifraWsData = isBinary
      ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
      : raw.toString()
    safe(() => handler.message?.(nifra, payload))
  })
  ws.on("close", (code, reason) => {
    pubsub.unsubscribeAll(nifra) // drop topic subscriptions so the registry never holds a dead socket
    safe(() => handler.close?.(nifra, code, reason.toString()))
  })
  ws.on("error", (error) => reportError(error))
  safe(() => handler.open?.(nifra)) // open: the socket is already established here
}

/** Write a minimal JSON error response to a raw upgrade socket, then close it. */
function writeUpgradeRejection(socket: Duplex, status: number, error: string): void {
  const body = JSON.stringify({ ok: false, error })
  socket.write(
    `HTTP/1.1 ${status} ${WS_STATUS_TEXT[status] ?? "Error"}\r\n` +
      `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n` +
      "Connection: close\r\n\r\n" +
      body,
  )
  socket.destroy()
}

/** Serialize a nifra guard's rejection `Response` (e.g. a 401) to a raw upgrade socket, then close. */
async function writeRejectionResponse(socket: Duplex, response: Response): Promise<void> {
  const body = await response.text()
  let head = `HTTP/1.1 ${response.status} ${response.statusText || WS_STATUS_TEXT[response.status] || "Error"}\r\n`
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "content-length") head += `${key}: ${value}\r\n`
  })
  head += `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n`
  socket.write(head + body)
  socket.destroy()
}
