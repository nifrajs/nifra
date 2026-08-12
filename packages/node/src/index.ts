/**
 * Run a nifra app (or any Web-`fetch` handler) on Node's `http` server.
 *
 *   import { serve } from "@nifrajs/node"
 *   import { server } from "@nifrajs/core/server"
 *   const app = server().get("/", () => ({ ok: true }))
 *   serve(app, { port: 3000 })
 *
 * nifra's lifecycle is `app.fetch(Request): Response | Promise<Response>` - pure Web Standards -
 * so this adapter just bridges Node's stream-based `(req, res)` to/from Web
 * `Request`/`Response`, plus a Bun-`listen()`-style graceful `stop()`.
 */
import { AsyncLocalStorage } from "node:async_hooks"
import { open, realpath } from "node:fs/promises"
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import { extname, isAbsolute, relative, resolve, sep } from "node:path"
import { type Duplex, Readable } from "node:stream"
import { fileURLToPath } from "node:url"
// srvx's lazy spec-shaped Response - see nodeOutcomeToResponse for why the bridge uses it.
import { FastResponse } from "srvx/node"
import type { NodeServeOutcome } from "./generated/node-outcome.ts"

/** The runtime platform a nifra app accepts as `fetch`'s 2nd arg - here, the observed socket peer. */
interface NodePlatform {
  readonly clientIp?: string
}

/** Anything exposing a Web `fetch` handler - a nifra `app`, for instance. */
export interface FetchHandler {
  fetch(request: Request, platform?: NodePlatform): Response | Promise<Response>
  /** Nifra apps also expose this WS-upgrade seam; present → this adapter serves `app.ws()` routes via
   * the optional `ws` package (lazy-imported on the first upgrade). Absent (a plain `{ fetch }`
   * handler) → HTTP only, and an upgrade request gets a 404. */
  resolveWebSocketUpgrade?(request: Request): WsUpgradeOutcome | Promise<WsUpgradeOutcome>
}

// --- WebSocket types: structurally mirrored from @nifrajs/core. The adapter stays dependency-free;
// the runtime outcome contract below is generated from core as a separate type-only artifact. ---

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

/** Mirror of core's `TopicRegistry` surface - the app's pub/sub the adapter wires `ws.subscribe` to. */
interface WsPubSub {
  subscribe(topic: string, ws: NifraWs): void
  unsubscribe(topic: string, ws: NifraWs): void
  unsubscribeAll(ws: NifraWs): void
}

/** A nifra WS route's lifecycle (mirror of core's `WebSocketHandler` - the post-upgrade callbacks). */
interface NifraWsHandler {
  open?(ws: NifraWs): void | Promise<void>
  message?(ws: NifraWs, data: NifraWsData): void | Promise<void>
  close?(ws: NifraWs, code: number, reason: string): void | Promise<void>
  error?(ws: NifraWs, error: unknown): void | Promise<void>
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
    }

/** Structural view of the `ws` package's `WebSocket` (no `@types/ws` dependency - see `loadWsServer`). */
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

/** The node-direct render contract is generated from core at build time into `./generated`. */

interface NodeRequestSource {
  readonly method: string
  readonly url: string
  /** Pre-split origin-form target - core routes from this without building the absolute URL. */
  readonly urlParts: { readonly pathname: string; readonly search: string }
  readonly headers: Headers
  header(name: string): string | null
  readonly body: ReadableStream<Uint8Array> | null
  arrayBuffer(): Promise<ArrayBuffer>
  json(): Promise<unknown>
  jsonWithByteLength?(): Promise<{ readonly value: unknown; readonly byteLength: number }>
  readonly request: Request
}

interface NodeContextSet {
  readonly status?: number
  readonly _headers?: Record<string, string>
  readonly _cookies?: string[]
}

interface NodeOutcomeRuntime {
  toOutcome(result: unknown, set: NodeContextSet): NodeServeOutcome
  toResponse(outcome: NodeServeOutcome): Response
  fromResponse(response: Response): NodeServeOutcome
  timeout(): NodeServeOutcome
  /** The Content-Type the json render writes implicitly - surfaced to core's native hook walk. */
  readonly jsonContentType?: string
}

/** A `FetchHandler` that *also* exposes the node-direct fast path (every nifra app does). May resolve
 * **synchronously** (a bare route + sync handler allocates no promise) - we `await` it regardless. */
interface NodeFastHandler extends FetchHandler {
  resolveNode(
    request: Request,
    platform?: NodePlatform,
  ): NodeServeOutcome | Promise<NodeServeOutcome>
  resolveNodeSource(
    source: NodeRequestSource,
    platform: NodePlatform | undefined,
    runtime: NodeOutcomeRuntime,
  ): NodeServeOutcome | Promise<NodeServeOutcome>
}

/**
 * The `Content-Type` the host runtime's `Response.json` emits - Node's undici uses `application/json`,
 * Bun uses `application/json;charset=utf-8`. Probed once at module load (zero per-request cost) so the
 * fast path is byte-for-byte identical to the `Response`-building path on whatever runtime hosts us.
 */
const JSON_CONTENT_TYPE = Response.json(0).headers.get("content-type") ?? "application/json"

const INTERNAL_ERROR_BODY = '{"ok":false,"error":"internal_error"}'
const EMPTY_BUFFER = Buffer.alloc(0)
const NODE_RESPONSE_BODY = Symbol.for("nifra.response.body")
const RESPONSE_RESULT = Symbol.for("nifra.response.result")

function isBodylessStatus(status: number): boolean {
  return status === 204 || status === 205 || status === 304
}

function normalizeBodylessResponse(response: Response): Response {
  if (!isBodylessStatus(response.status)) return response
  if (response.body === null && !response.headers.has("content-length")) return response
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

const NODE_OUTCOME_RUNTIME: NodeOutcomeRuntime = {
  toOutcome(result, set) {
    if (isResponseResult(result)) {
      const body = result.toNodeBody?.()
      if (body !== undefined) {
        return {
          kind: "body",
          status: body.status,
          headers: appendCookiesToNodeHeaders(body.headers, set._cookies),
          body: isBodylessStatus(body.status) ? new Uint8Array(0) : body.body,
        }
      }
      return nodeOutcomeFromResponse(appendCookiesToResponse(result.toResponse(), set._cookies))
    }
    if (result instanceof Response) {
      return nodeOutcomeFromResponse(appendCookiesToResponse(result, set._cookies))
    }
    const status = set.status ?? (result === undefined ? 204 : 200)
    const body = result === undefined || isBodylessStatus(status) ? null : JSON.stringify(result)
    return {
      kind: "json",
      status,
      headers: set._headers,
      cookies: set._cookies,
      body,
    }
  },
  toResponse: nodeOutcomeToResponse,
  fromResponse: nodeOutcomeFromResponse,
  timeout: () => ({
    kind: "response",
    response: Response.json({ ok: false, error: "request_timeout" }, { status: 503 }),
  }),
  jsonContentType: JSON_CONTENT_TYPE,
}

interface NodeResponseResult {
  readonly [RESPONSE_RESULT]: true
  toResponse(): Response
  toNodeBody?(): {
    readonly status: number
    readonly headers: Readonly<Record<string, string | readonly string[]>> | undefined
    readonly body: string | Uint8Array
  }
}

function isResponseResult(value: unknown): value is NodeResponseResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly [RESPONSE_RESULT]?: unknown })[RESPONSE_RESULT] === true &&
    typeof (value as { readonly toResponse?: unknown }).toResponse === "function"
  )
}

function appendCookiesToResponse(
  response: Response,
  cookies: readonly string[] | undefined,
): Response {
  if (cookies !== undefined) {
    for (const cookie of cookies) response.headers.append("set-cookie", cookie)
  }
  return response
}

function nodeOutcomeFromResponse(response: Response): NodeServeOutcome {
  response = normalizeBodylessResponse(response)
  if (!response.bodyUsed) {
    const body = (response as { readonly [NODE_RESPONSE_BODY]?: unknown })[NODE_RESPONSE_BODY]
    if (typeof body === "string" || body instanceof Uint8Array) {
      return { kind: "body", status: response.status, headers: responseHeaders(response), body }
    }
  }
  return { kind: "response", response }
}

/**
 * Materialize only for a Web response hook; preserve the buffered marker for in-place transforms.
 *
 * Built as a `FastResponse` (srvx): a LAZY spec-shaped Response that stores the body + init and
 * materializes a real `Headers`/body stream only when a hook actually touches them - an undici
 * `Response` here paid ~5μs of body-stream and webidl setup per request before any hook ran, the
 * single largest cost of the twin-less fallback path. Headers ride as a PAIRS list in the init
 * (repeated `Set-Cookie` lines stay un-joined) and become one real `Headers` on first access.
 * Trade, documented: a `FastResponse` duck-types the full Response surface but is not
 * `instanceof Response`.
 */
function nodeOutcomeToResponse(outcome: NodeServeOutcome): Response {
  if (outcome.kind === "response") return outcome.response
  const pairs: Array<[string, string]> = []
  let hasContentType = false
  if (outcome.headers !== undefined) {
    for (const [name, value] of Object.entries(outcome.headers)) {
      if (typeof value !== "string") {
        for (const item of value) pairs.push([name, item])
      } else {
        pairs.push([name, value])
      }
      if (!hasContentType && name.length === 12 && name.toLowerCase() === "content-type") {
        hasContentType = true
      }
    }
  }
  if (outcome.kind === "json") {
    if (outcome.cookies !== undefined) {
      for (const cookie of outcome.cookies) pairs.push(["set-cookie", cookie])
    }
    if (outcome.body !== null && !hasContentType) {
      pairs.push(["content-type", JSON_CONTENT_TYPE])
    }
  }
  if (isBodylessStatus(outcome.status)) {
    for (let i = pairs.length - 1; i >= 0; i--) {
      if (pairs[i]?.[0].toLowerCase() === "content-length") pairs.splice(i, 1)
    }
  }
  const body = isBodylessStatus(outcome.status) ? null : outcome.body
  const response = new FastResponse(body, {
    status: outcome.status,
    headers: pairs,
  }) as unknown as Response
  if (body !== null) Object.defineProperty(response, NODE_RESPONSE_BODY, { value: body })
  return response
}

function responseHeaders(
  response: Response,
): Readonly<Record<string, string | readonly string[]>> | undefined {
  let headers: Record<string, string | readonly string[]> | undefined
  response.headers.forEach((value, key) => {
    headers ??= Object.create(null) as Record<string, string | readonly string[]>
    headers[key] = value
  })
  const cookies = response.headers.getSetCookie?.()
  if (cookies !== undefined && cookies.length > 0) {
    headers ??= Object.create(null) as Record<string, string | readonly string[]>
    headers["set-cookie"] = cookies
  }
  return headers
}

function appendCookiesToNodeHeaders(
  headers: Readonly<Record<string, string | readonly string[]>> | undefined,
  cookies: readonly string[] | undefined,
): Readonly<Record<string, string | readonly string[]>> | undefined {
  if (cookies === undefined || cookies.length === 0) return headers
  const out = Object.create(null) as Record<string, string | readonly string[]>
  if (headers !== undefined) Object.assign(out, headers)
  const existing = out["set-cookie"]
  const setCookies =
    existing === undefined ? [] : typeof existing === "string" ? [existing] : [...existing]
  out["set-cookie"] = [...setCookies, ...cookies]
  return out
}

/**
 * Serve static files from a directory (e.g. the client build) under a URL prefix - so a self-hosted
 * Node deploy doesn't need a CDN or a hand-rolled `/assets/*` handler. (On Cloudflare/Vercel the
 * platform serves assets; this is for `node server.js`.)
 */
export interface ServeStaticOptions {
  /** Directory to read files from - an absolute path or a `file://` URL (`new URL("./assets/", import.meta.url)`). */
  readonly dir: string | URL
  /** URL prefix these files are served under. Default `"/assets"`. Use `"/"` to serve the whole dir. */
  readonly prefix?: string
  /** Emit `cache-control: public, max-age=31536000, immutable` - correct for content-hashed files. Default `true`. */
  readonly immutable?: boolean
  /** Extra headers merged onto every served file. */
  readonly headers?: Readonly<Record<string, string>>
  /**
   * Whether a path with a dot-leading segment (`/.env`, `/.git/config`, `/.hidden/app.js`) is
   * served. Default `"deny"`: answered `404` - the same response as a missing file, so probing
   * can't distinguish "hidden" from "absent". Dotfiles land in build output by accident, not by
   * design (`.env` next to the bundle, a `.git` dir in a copied tree), so serving them is opt-in.
   * Set `"allow"` if the directory deliberately contains them (e.g. `/.well-known`).
   */
  readonly dotfiles?: "deny" | "allow"
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
  /** Reject requests whose normalized Host authority is not in this allowlist or callback result. */
  readonly allowedHosts?: readonly string[] | ((host: string) => boolean)
  /** Use this validated authority when constructing Request.url, ignoring the inbound Host value. */
  readonly canonicalHost?: string
  /**
   * Install SIGTERM/SIGINT handlers that call `stop()` for a graceful drain on
   * `docker stop` / Ctrl-C. Off by default - taking over process signals is opt-in,
   * mirroring nifra's Bun `listen({ gracefulSignals })`.
   *
   * The app-level request timeout (`server({ requestTimeoutMs })` → 503) and body cap
   * are *not* set here - they live inside `app.fetch`, so they already apply through
   * this adapter. Slow-client protection is Node's built-in `requestTimeout` (300s) /
   * `headersTimeout` (60s) defaults.
   */
  readonly signals?: boolean
  /**
   * Serve static files from disk for matching GET/HEAD requests *before* the app runs - non-matching
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

interface HostPolicy {
  readonly allowedHosts: ReadonlySet<string> | ((host: string) => boolean) | undefined
  readonly canonicalHost: string | undefined
}

function normalizeHostAuthority(value: string): string | undefined {
  if (value.length === 0 || /[\r\n\s@/?#]/.test(value)) return undefined
  let hostname: string
  let port: string | undefined
  if (value.startsWith("[")) {
    const close = value.indexOf("]")
    if (close === -1) return undefined
    hostname = value.slice(1, close)
    const rest = value.slice(close + 1)
    if (rest !== "") {
      if (!rest.startsWith(":")) return undefined
      port = rest.slice(1)
    }
    if (hostname.length === 0 || !/^[0-9a-f:.%]+$/i.test(hostname)) return undefined
    hostname = `[${hostname.toLowerCase()}]`
  } else {
    const colon = value.indexOf(":")
    if (colon === -1) {
      hostname = value
    } else {
      if (value.indexOf(":", colon + 1) !== -1) return undefined
      hostname = value.slice(0, colon)
      port = value.slice(colon + 1)
    }
    if (hostname.length === 0 || !/^[a-z0-9.-]+$/i.test(hostname)) return undefined
    hostname = hostname.toLowerCase()
  }
  if (port !== undefined) {
    if (!/^\d{1,5}$/.test(port)) return undefined
    const numericPort = Number(port)
    if (!Number.isSafeInteger(numericPort) || numericPort > 65_535) return undefined
    port = String(numericPort)
  }
  return port === undefined ? hostname : `${hostname}:${port}`
}

function hostPolicyOf(options: ServeOptions): HostPolicy {
  let allowedHosts: HostPolicy["allowedHosts"]
  if (options.allowedHosts !== undefined && typeof options.allowedHosts !== "function") {
    const normalized = new Set<string>()
    for (const host of options.allowedHosts) {
      const parsed = normalizeHostAuthority(host)
      if (parsed === undefined) throw new TypeError(`@nifrajs/node: invalid allowed host ${host}`)
      normalized.add(parsed)
    }
    allowedHosts = normalized
  } else {
    allowedHosts = options.allowedHosts
  }
  const canonicalHost =
    options.canonicalHost === undefined ? undefined : normalizeHostAuthority(options.canonicalHost)
  if (options.canonicalHost !== undefined && canonicalHost === undefined) {
    throw new TypeError(`@nifrajs/node: invalid canonical host ${options.canonicalHost}`)
  }
  return { allowedHosts, canonicalHost }
}

// Last inbound Host and what it normalized to. Normalization is pure and the value repeats for
// every request of a deployment (one authority, reused across connections), so a one-entry memo
// turns three regex tests plus the slicing into a string compare - measured 135ns -> ~3ns per
// request on Node 26. A miss just runs the normalizer, so an attacker rotating the header only
// gives up the cache, never correctness.
let lastHostInput: string | undefined
let lastHostOutput: string | undefined

function normalizeHostCached(value: string): string | undefined {
  if (value === lastHostInput) return lastHostOutput
  const normalized = normalizeHostAuthority(value)
  lastHostInput = value
  lastHostOutput = normalized
  return normalized
}

function requestHost(req: IncomingMessage, policy: HostPolicy): string | undefined {
  const inbound = typeof req.headers.host === "string" ? req.headers.host : "localhost"
  const normalized = normalizeHostCached(inbound)
  if (normalized === undefined) return undefined
  if (policy.allowedHosts !== undefined) {
    try {
      const allowed =
        typeof policy.allowedHosts === "function"
          ? policy.allowedHosts(normalized)
          : policy.allowedHosts.has(normalized)
      if (!allowed) return undefined
    } catch {
      return undefined
    }
  }
  return policy.canonicalHost ?? normalized
}

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
  readonly denyDotfiles: boolean
}

function staticStateOf(options: ServeStaticOptions): StaticState {
  const root = resolve(typeof options.dir === "string" ? options.dir : fileURLToPath(options.dir))
  const raw = options.prefix ?? "/assets"
  // Index scans, not `/^\/+|\/+$/g` - the trailing-run half backtracks quadratically.
  let from = 0
  while (from < raw.length && raw.charCodeAt(from) === 47 /* '/' */) from++
  let to = raw.length
  while (to > from && raw.charCodeAt(to - 1) === 47) to--
  const prefix = raw === "/" ? "/" : `/${raw.slice(from, to)}`
  return {
    root,
    prefix,
    immutable: options.immutable !== false,
    headers: options.headers,
    denyDotfiles: options.dotfiles !== "allow",
  }
}

/**
 * Resolve a request URL to a file under the served root - **synchronously**, so non-matching requests
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
  // Reject traversal in the REQUEST form before it ever reaches the filesystem path join: a `..`
  // path segment (or a backslash Windows would treat as a separator) has no legitimate use in an
  // asset URL. Segment-precise on purpose - a filename merely CONTAINING `..` (`logo..png`) is legal.
  // The same segment pass covers dotfiles: the check runs post-decode, so `%2E`-spelled dots are
  // already plain `.` here. Denied dotfiles answer 404, not 403 - identical to a missing file, so
  // probing can't distinguish "hidden" from "absent" (traversal keeps its 403: `..` is an attack
  // shape, and there is nothing behind it to conceal).
  const segments = rel.split("/")
  if (segments.includes("..") || rel.includes("\\")) {
    return { reject: new Response("Forbidden", { status: 403 }) }
  }
  if (state.denyDotfiles) {
    for (const segment of segments) {
      if (segment.charCodeAt(0) === 46 /* '.' */) {
        return { reject: new Response("Not Found", { status: 404 }) }
      }
    }
  }
  const file = resolve(state.root, rel)
  // Confine to the served directory - the resolved path must sit at or below root.
  const contained = relative(state.root, file)
  if (contained.startsWith("..") || isAbsolute(contained)) {
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
 * Serve a Web-`fetch` app on a Node `http` server. Resolves once bound - Node binds
 * the port asynchronously, so awaiting gives you the real port (matters for `port: 0`).
 */
// The node-direct fast path renders plain data instead of building + draining a `Response`. Serving on
// Node installs it on the app via the registered install symbol, so `app.resolveNode()` works because
// you are on the Node runtime - no `.use()` opt-in. Decoupled by design: we reference the symbol, not
// @nifrajs/core, and no-op on a handler that does not expose the seam (a plain `{ fetch }`) or one that
// is already frozen (the per-request `resolveNodeSource` path supplies the runtime regardless).
const INSTALL_NODE_DIRECT = Symbol.for("@nifrajs/core/install-node-direct")
function enableNodeDirect(app: FetchHandler): void {
  const install = (app as unknown as Record<symbol, unknown>)[INSTALL_NODE_DIRECT]
  if (typeof install !== "function") return
  try {
    ;(install as (runtime: NodeOutcomeRuntime) => void).call(app, NODE_OUTCOME_RUNTIME)
  } catch {
    // Already frozen (served/listened before) - node-direct still works via the per-call supply.
  }
}

// Node's per-tick async-context bookkeeping (AsyncContextFrame, default since Node 24) activates
// lazily, on the first `AsyncLocalStorage` construction - or, in a process that never constructs
// one, on the first socket teardown's `clearTimeout`, which reads the same gate. That second path
// makes activation inevitable for any http server, and mid-traffic is the worst possible moment:
// V8 has already optimized the tick loop against the inactive no-op frame methods, and the
// prototype swap leaves the per-tick exchange callsite polymorphic for the process lifetime
// (~3% of per-request CPU on Node 26, measured). Constructing one storage before listening moves
// the flip ahead of the loop's first optimization instead; the instance itself is never used.
// Under --no-async-context-frame the constructor is inert (legacy ALS enables hooks on first
// run()/enterWith(), not on construction), so this is a no-op there.
let asyncContextFrameActivated = false
function activateAsyncContextFrame(): void {
  if (asyncContextFrameActivated) return
  asyncContextFrameActivated = true
  new AsyncLocalStorage()
}

export function serve(app: FetchHandler, options: ServeOptions): Promise<NodeServer> {
  activateAsyncContextFrame()
  enableNodeDirect(app)
  let inFlight = 0
  let closed = false
  const protocol = protocolResolver(options.protocol)
  const hostPolicy = hostPolicyOf(options)
  const staticState = options.static !== undefined ? staticStateOf(options.static) : undefined
  const server = createServer((nodeReq, nodeRes) => {
    inFlight += 1
    try {
      const handled = handle(app, nodeReq, nodeRes, protocol, staticState, hostPolicy)
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
  // the optional `ws` package - lazy-imported (and the server lazily built) on the FIRST real WS
  // upgrade, so a non-WS Node app never loads `ws`.
  const resolveWs = app.resolveWebSocketUpgrade?.bind(app)
  if (resolveWs !== undefined) {
    let wssPromise: Promise<WsServer | undefined> | undefined
    server.on("upgrade", (nodeReq, socket, head) => {
      void handleUpgrade(resolveWs, protocol, hostPolicy, nodeReq, socket, head, () => {
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
    // Do not pass an explicit `undefined` hostname. Node accepts it, but Bun's Node-compatible
    // `http.Server.listen` can misinterpret that overload (especially with port 0) as a failed bind.
    // Omitting the argument selects the same default host while keeping the overload unambiguous.
    const onListening = (): void => {
      const address = server.address()
      const port = address !== null && typeof address === "object" ? address.port : options.port
      if (options.signals === true) {
        process.once("SIGTERM", onSignal)
        process.once("SIGINT", onSignal)
      }
      resolve({ port, stop })
    }
    if (options.hostname === undefined) server.listen(options.port, onListening)
    else server.listen(options.port, options.hostname, onListening)
  })
}

function handle(
  app: FetchHandler,
  nodeReq: IncomingMessage,
  nodeRes: ServerResponse,
  getProtocol: RequestProtocolResolver,
  staticState: StaticState | undefined,
  hostPolicy: HostPolicy,
): void | Promise<void> {
  const host = requestHost(nodeReq, hostPolicy)
  if (host === undefined) {
    writeBadRequest(nodeRes)
    return
  }
  let protocol: RequestProtocol
  try {
    protocol = getProtocol(nodeReq)
  } catch {
    writeInternalError(nodeRes)
    return
  }

  // The TCP socket peer (the one address a client can't forge) → `c.clientIp`, unless the app's
  // `clientIp` trust declaration derives it from the forwarding chain instead. `undefined` for an
  // already-closed socket. The peer is constant for a socket's lifetime, so the platform object is
  // built once per CONNECTION and reused across every keep-alive request on it.
  const socket = nodeReq.socket as (typeof nodeReq.socket & { [PLATFORM]?: NodePlatform }) | null
  let platform = socket?.[PLATFORM]
  if (platform === undefined) {
    const peerAddress = socket?.remoteAddress
    if (peerAddress !== undefined && socket !== null) {
      platform = { clientIp: peerAddress }
      socket[PLATFORM] = platform
    }
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
  // write straight to the socket - skipping the undici `Response` build + body drain (the bulk of the
  // Web-bridge cost on Node). A handler-returned `Response`/redirect, 404/405, error, timeout, or any
  // `onResponse` hook comes back as `{ kind: "response" }` and takes the same Web path as before, so
  // behavior is identical. A plain `{ fetch }` handler (no `resolveNode`) uses the Web path too.
  const resolveNodeSource = (app as Partial<NodeFastHandler>).resolveNodeSource
  if (typeof resolveNodeSource === "function") {
    try {
      const outcome = resolveNodeSource.call(
        app,
        toNodeRequestSource(nodeReq, protocol, host),
        platform,
        NODE_OUTCOME_RUNTIME,
      )
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

  const request = toWebRequest(nodeReq, protocol, host)
  const resolveNode = (app as Partial<NodeFastHandler>).resolveNode
  if (typeof resolveNode === "function") {
    try {
      const outcome = resolveNode.call(app, request, platform)
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
    const response = app.fetch(request, platform)
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

/** A flat 500 with no leaked detail - the adapter's last-resort guard if a handler throws. */
function writeInternalError(nodeRes: ServerResponse): void {
  nodeRes.writeHead(500, { "content-type": "application/json" })
  nodeRes.end(INTERNAL_ERROR_BODY)
}

function writeBadRequest(nodeRes: ServerResponse): void {
  const body = "Bad Request"
  nodeRes.writeHead(400, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
  })
  nodeRes.end(body)
}

/** True when every header name in the record is already free of ASCII uppercase - the gate for
 * skipping the per-request lowercase normalization copy in {@link writeJsonOutcome}. */
function allHeaderKeysLowercase(record: Readonly<Record<string, unknown>>): boolean {
  for (const key of Object.keys(record)) {
    for (let i = 0; i < key.length; i++) {
      const c = key.charCodeAt(i)
      if (c >= 65 && c <= 90) return false
    }
  }
  return true
}

/**
 * Serialize a node-direct JSON outcome straight to the socket - no undici `Response`, no stream drain.
 * Mirrors `Response.json(data, { status, headers })` byte-for-byte: user headers are lowercased to
 * match undici's `Headers` normalization, the JSON `Content-Type` matches the host runtime's, and each
 * queued cookie is emitted as its own `Set-Cookie` line (never comma-joined).
 */
function writeJsonOutcome(
  outcome: Extract<NodeServeOutcome, { kind: "json" }>,
  nodeRes: ServerResponse,
): void {
  // The outcome's record is the request's own (`c.set.headers`, already mutated by any native
  // response hooks), and its writers - middleware twins and the framework's own additions - emit
  // lowercase names. When a key scan confirms that, the record is used as-is and the additions
  // below mutate it in place; nothing reads it after the write. Only a mixed-case key (a user's
  // hand-set `X-Foo`) pays the normalization copy, keeping the wire byte-identical to undici's
  // `Headers` lowercasing on every other runtime.
  let headers: Record<string, string | string[]>
  const source = outcome.headers
  if (source === undefined) {
    // A route that set no headers gets a record the FRAMEWORK alone fills - content-type,
    // content-length, set-cookie - so no attacker-influenced name can reach it and the
    // null-prototype guard the normalization branch needs buys nothing here. It does cost: a
    // null-prototype object never enters V8's fast property mode, and Node's `_storeHeader` walks
    // this record key by key on every response (measured at over twice fastify's share of the same
    // frame on a bare route). A literal keeps it in fast mode.
    headers = {}
  } else if (allHeaderKeysLowercase(source)) {
    headers = source as Record<string, string | string[]>
  } else {
    headers = Object.create(null) as Record<string, string | string[]>
    for (const [key, value] of Object.entries(source)) {
      headers[key.toLowerCase()] = value as string | string[]
    }
  }
  // A `null` body is a 204/no-content render - `new Response(null)` carries no Content-Type, so we add
  // none either; a non-null body is JSON, matching `Response.json`'s Content-Type (a hook-supplied
  // Content-Type wins). The length is known regardless of who set the type, so always declare it -
  // without it Node falls back to chunked framing, which costs extra wire bytes and client parsing
  // on every response (and no other runtime chunks a buffered JSON body).
  if (outcome.body !== null) {
    if (headers["content-type"] === undefined) headers["content-type"] = JSON_CONTENT_TYPE
    headers["content-length"] = String(Buffer.byteLength(outcome.body))
  } else if (isBodylessStatus(outcome.status)) {
    // 204/205/304 never carry a payload; discard a user/native-hook length even when the body is
    // already represented as null so the direct writer cannot advertise bytes that will not ship.
    delete headers["content-length"]
  }
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
  // Body outcomes already carry response-normalized header names and values. Node consumes the same
  // mutable runtime shapes (`string` / `string[]`); avoid cloning this record and every Set-Cookie
  // array on the hot SSR path. The readonly type is an ownership guarantee from the producer, not a
  // runtime value Node mutates.
  const headers = outcome.headers as Record<string, string | string[]> | undefined
  if (isBodylessStatus(outcome.status)) {
    const lengthKey =
      headers === undefined
        ? undefined
        : Object.keys(headers).find((key) => key.toLowerCase() === "content-length")
    if (headers !== undefined && lengthKey !== undefined) delete headers[lengthKey]
    nodeRes.writeHead(outcome.status, headers)
    nodeRes.end()
    return
  }
  // The body is buffered, so its length is known - declare it unless the producer already did.
  // Without a length Node falls back to chunked framing (extra wire bytes on every SSR response).
  if (headers === undefined) {
    nodeRes.setHeader("content-length", byteLengthOf(outcome.body))
    nodeRes.writeHead(outcome.status)
  } else {
    const lengthKey = Object.keys(headers).find((key) => key.toLowerCase() === "content-length")
    if (lengthKey === undefined) {
      headers["content-length"] = String(byteLengthOf(outcome.body))
    }
    nodeRes.writeHead(outcome.status, headers)
  }
  nodeRes.end(outcome.body)
}

const byteLengthOf = (body: string | Uint8Array): number =>
  typeof body === "string" ? Buffer.byteLength(body) : body.byteLength

/** Per-connection cache slot for the socket-peer platform object (see `handle`). */
const PLATFORM = Symbol("nifra.node.platform")

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

function toWebRequest(req: IncomingMessage, protocol: RequestProtocol, host: string): Request {
  const url = `${protocol}://${host}${req.url ?? "/"}`
  const method = req.method ?? "GET"
  return makeWebRequest(req, method, url, headerRecordFromNode(req.headers))
}

function toNodeRequestSource(
  req: IncomingMessage,
  protocol: RequestProtocol,
  host: string,
): NodeRequestSource {
  const method = req.method ?? "GET"
  return method === "GET" || method === "HEAD"
    ? new LeanNodeGetSource(req, method, protocol, host)
    : new LazyNodeRequestSource(req, method, protocol, host)
}

/**
 * Split an origin-form request target ("/path?q#frag") into pathname + search without synthesizing
 * an absolute URL first. Mirrors `@nifrajs/core`'s `urlPartsOf` for the origin-form case (kept in
 * lockstep by the serve integration test).
 */
function originUrlParts(target: string): { pathname: string; search: string } {
  let pathEnd = target.length
  let searchStart = -1
  let searchEnd = target.length
  for (let i = 0; i < target.length; i++) {
    const c = target.charCodeAt(i)
    if (c === 63 /* ? */ && searchStart === -1) {
      pathEnd = i
      searchStart = i
    } else if (c === 35 /* # */) {
      if (searchStart === -1) pathEnd = i
      searchEnd = i
      break
    }
  }
  return {
    pathname: pathEnd === 0 ? "/" : target.slice(0, pathEnd),
    search: searchStart === -1 ? "" : target.slice(searchStart, searchEnd),
  }
}

/**
 * Lazy view over a Node `IncomingMessage`. Methods live on the prototype (not re-allocated per
 * request), and every materialization is deferred: the `Headers` object, the Web `ReadableStream`
 * body, and the undici `Request` are each built only when first read. Body-capable methods use this
 * source; GET/HEAD use the smaller {@link LeanNodeGetSource}.
 */
class LazyNodeRequestSource implements NodeRequestSource {
  readonly method: string

  private headersValue: Headers | undefined
  private bodyValue: ReadableStream<Uint8Array> | null | undefined
  private requestValue: Request | undefined
  private consumedBody: Buffer | undefined
  private readBodyPromise: Promise<Buffer> | undefined
  private urlValue: string | undefined
  private readonly nodeReq: IncomingMessage
  private readonly protocol: RequestProtocol
  private readonly host: string

  constructor(nodeReq: IncomingMessage, method: string, protocol: RequestProtocol, host: string) {
    this.nodeReq = nodeReq
    this.method = method
    this.protocol = protocol
    this.host = host
  }

  /** The absolute URL, built only when something reads it - routing uses `urlParts` instead. */
  get url(): string {
    this.urlValue ??= `${this.protocol}://${this.host}${this.nodeReq.url ?? "/"}`
    return this.urlValue
  }

  get urlParts(): { pathname: string; search: string } {
    return originUrlParts(this.nodeReq.url ?? "/")
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

  jsonWithByteLength(): Promise<{ readonly value: unknown; readonly byteLength: number }> {
    if (this.requestValue !== undefined) {
      return this.requestValue.arrayBuffer().then((buffer) => ({
        value: JSON.parse(Buffer.from(buffer).toString("utf8")) as unknown,
        byteLength: buffer.byteLength,
      }))
    }
    return this.readNodeBody().then((buffer) => ({
      value: JSON.parse(buffer.toString("utf8")) as unknown,
      byteLength: buffer.byteLength,
    }))
  }

  get request(): Request {
    this.requestValue ??= new LazyWebRequest(
      this.method,
      this.url,
      () => this.headersValue ?? headerRecordFromNode(this.nodeReq.headers),
      (headers) => {
        if (this.consumedBody !== undefined) {
          const real = makeWebRequest(
            this.nodeReq,
            this.method,
            this.url,
            headers,
            this.consumedBody,
          )
          // Preserve one-shot body semantics if user code asks for `c.req` after nifra already
          // consumed it.
          void real.arrayBuffer().catch(() => {})
          return real
        }
        return makeWebRequest(this.nodeReq, this.method, this.url, headers, this.body)
      },
    ) as unknown as Request
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

/**
 * GET/HEAD requests dominate API reads and never carry a body. This source keeps that path lean while
 * preserving the full Web `Request` escape hatch if user code reads `c.req`/`c.request`.
 */
class LeanNodeGetSource implements NodeRequestSource {
  readonly method: string

  private headersValue: Headers | undefined
  private requestValue: Request | undefined
  private urlValue: string | undefined
  private readonly nodeReq: IncomingMessage
  private readonly protocol: RequestProtocol
  private readonly host: string

  constructor(nodeReq: IncomingMessage, method: string, protocol: RequestProtocol, host: string) {
    this.nodeReq = nodeReq
    this.method = method
    this.protocol = protocol
    this.host = host
  }

  /** The absolute URL, built only when something reads it - routing uses `urlParts` instead. */
  get url(): string {
    this.urlValue ??= `${this.protocol}://${this.host}${this.nodeReq.url ?? "/"}`
    return this.urlValue
  }

  get urlParts(): { pathname: string; search: string } {
    return originUrlParts(this.nodeReq.url ?? "/")
  }

  get headers(): Headers {
    this.headersValue ??= headersFromNode(this.nodeReq.headers)
    return this.headersValue
  }

  header(name: string): string | null {
    const value = this.nodeReq.headers[name.toLowerCase()]
    if (value === undefined) return null
    return Array.isArray(value) ? value.join(", ") : value
  }

  get body(): null {
    return null
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    return Promise.resolve(new ArrayBuffer(0))
  }

  json(): Promise<unknown> {
    return Promise.reject(new SyntaxError("Unexpected end of JSON input"))
  }

  get request(): Request {
    this.requestValue ??= new LazyWebRequest(
      this.method,
      this.url,
      () => this.headersValue ?? headerRecordFromNode(this.nodeReq.headers),
      (headers) => makeWebRequest(this.nodeReq, this.method, this.url, headers, null),
    ) as unknown as Request
    return this.requestValue
  }
}

function headersFromNode(input: IncomingHttpHeaders): Headers {
  return new Headers(headerRecordFromNode(input))
}

/**
 * Node's already-lowercased header bag as a plain record (multi-values comma-joined, matching the
 * Web `Headers` view of the same request). Used as a `HeadersInit` so building a Web `Request`
 * costs ONE undici header-list fill - `new Request(url, { headers: someHeaders })` would build a
 * `Headers` (validating every name/value) and then copy it into the request's own list, validating
 * everything a second time.
 */
function headerRecordFromNode(input: IncomingHttpHeaders): Record<string, string> {
  const record = Object.create(null) as Record<string, string>
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue
    record[key] = Array.isArray(value) ? value.join(", ") : value
  }
  return record
}

function makeWebRequest(
  req: IncomingMessage,
  method: string,
  url: string,
  headers: Headers | Record<string, string>,
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

/**
 * A LAZY Web `Request` over a Node request. Constructing an undici `Request` costs ~2μs per call -
 * its internal URL parse alone showed at ~2.4% of a realistic request - yet most consumers of
 * `c.req` (and of the `req` argument Web hooks receive) only ever read `method`, `url`, or a
 * header. This class serves those three from what the adapter already has, materializes one real
 * `Headers` on first `headers` access, and defers the full undici `Request` until something
 * actually needs the rest of the surface (body readers, `signal`, `clone`, ...), forwarding to it
 * from then on. The prototype chains to the native `Request`, so `instanceof Request` holds and
 * every forwarded member runs with a genuine receiver. The `url` is ALWAYS the adapter's own
 * derivation (the declared protocol trust) - never re-derived here.
 */
const LazyWebRequest = /* @__PURE__ */ (() => {
  const NativeRequest = globalThis.Request
  class LazyWebRequest {
    #method: string
    #url: string
    #headersInit: (() => Headers | Record<string, string>) | undefined
    #materialize: ((headers: Headers | Record<string, string>) => Request) | undefined
    #headers: Headers | undefined
    #real: Request | undefined

    constructor(
      method: string,
      url: string,
      headersInit: () => Headers | Record<string, string>,
      materialize: (headers: Headers | Record<string, string>) => Request,
    ) {
      this.#method = method
      this.#url = url
      this.#headersInit = headersInit
      this.#materialize = materialize
    }

    get method(): string {
      return this.#method
    }

    get url(): string {
      return this.#url
    }

    get headers(): Headers {
      if (this.#headers !== undefined) return this.#headers
      if (this.#real !== undefined) {
        this.#headers = this.#real.headers
        return this.#headers
      }
      const init = (this.#headersInit as () => Headers | Record<string, string>)()
      this.#headers = init instanceof Headers ? init : new Headers(init)
      return this.#headers
    }

    /** The real undici Request, built on first demand. Named for the forwarding descriptors below. */
    get _real(): Request {
      if (this.#real === undefined) {
        const materialize = this.#materialize as (h: Headers | Record<string, string>) => Request
        // Hand the materializer the SAME Headers a hook may already have observed (and mutated),
        // so the real request reflects it; otherwise let it build from its own cheap record.
        this.#real = materialize(
          this.#headers ?? (this.#headersInit as () => Headers | Record<string, string>)(),
        )
        this.#headersInit = undefined
        this.#materialize = undefined
      }
      return this.#real
    }
  }

  // Forward every other Request member to the lazily materialized real request. Data properties
  // (e.g. Symbol.toStringTag) are reachable through the chained prototype without a brand check,
  // so only accessors and methods need explicit forwarding.
  const own = new Set<string | symbol>(["constructor", "method", "url", "headers"])
  const keys: Array<string | symbol> = [
    ...Object.getOwnPropertyNames(NativeRequest.prototype),
    ...Object.getOwnPropertySymbols(NativeRequest.prototype),
  ]
  for (const key of keys) {
    if (own.has(key)) continue
    const descriptor = Object.getOwnPropertyDescriptor(NativeRequest.prototype, key)
    if (descriptor === undefined) continue
    if (typeof descriptor.value === "function") {
      Object.defineProperty(LazyWebRequest.prototype, key, {
        configurable: true,
        writable: true,
        value: function (this: InstanceType<typeof LazyWebRequest>, ...args: unknown[]) {
          const real = this._real as unknown as Record<string | symbol, unknown>
          return (real[key] as (...a: unknown[]) => unknown).apply(real, args)
        },
      })
    } else if (descriptor.get !== undefined) {
      Object.defineProperty(LazyWebRequest.prototype, key, {
        configurable: true,
        get(this: InstanceType<typeof LazyWebRequest>) {
          return (this._real as unknown as Record<string | symbol, unknown>)[key]
        },
      })
    }
  }
  Object.setPrototypeOf(LazyWebRequest.prototype, NativeRequest.prototype)
  return LazyWebRequest
})()

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
  // `ServerResponse.setHeaders` (Node 18.14+) takes the Headers object directly and iterates its
  // native Symbol.iterator, which - unlike `Headers.forEach`/`.get()` - never comma-joins repeated
  // `Set-Cookie` values (Node's own implementation carries the identical correctness note this
  // function used to hand-implement via `getSetCookie()`). One native call instead of a manual
  // forEach into a fresh plain object plus a second cookie-specific pass. Must run before
  // `writeHead`: headers are already flushed by the time `writeHead` returns.
  nodeRes.setHeaders(response.headers)
  nodeRes.writeHead(response.status)
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

/** A non-literal specifier so TS treats `import(...)` as `any` - `ws` is an optional peer with no
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
    return undefined // `ws` not installed - caller responds 501
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
  hostPolicy: HostPolicy,
  nodeReq: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  getWss: () => Promise<WsServer | undefined>,
): Promise<void> {
  let outcome: WsUpgradeOutcome
  try {
    const host = requestHost(nodeReq, hostPolicy)
    if (host === undefined) {
      writeUpgradeRejection(socket, 400, "bad_request")
      return
    }
    outcome = await resolveWs(toWebRequest(nodeReq, getProtocol(nodeReq), host))
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
 * of core's `attachWebSocket` - binary frames normalize to `Uint8Array`; a thrown/rejected callback
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
