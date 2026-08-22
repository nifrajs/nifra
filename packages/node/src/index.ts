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
import { constants as FS } from "node:fs"
import { open, realpath } from "node:fs/promises"
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import { extname, isAbsolute, relative, resolve, sep } from "node:path"
import type { Duplex, Readable } from "node:stream"
import { fileURLToPath } from "node:url"
// srvx's lazy spec-shaped Response - see nodeOutcomeToResponse for why the bridge uses it.
import { FastResponse } from "srvx/node"
import { NODE_BRIDGE_MARKER_KEYS } from "./generated/bridge-markers.ts"
import type { NodeServeOutcome } from "./generated/node-outcome.ts"
import { claimableWebStream, claimNodeStream } from "./node-stream.ts"

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
      readonly maxPayloadBytes?: number
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
  rawBodyReaders?(): NodeRawBodyReaders
}

/** The request/response view handed to a mounted handler's optional native lane. It deliberately
 * keeps the raw IncomingMessage so an upstream client receives the original Node stream. */
interface NodeNativeMountRequest {
  readonly method: string
  readonly url: string
  readonly headers: IncomingHttpHeaders
  readonly raw: IncomingMessage
}

type NodeNativeMountHandler = (
  request: NodeNativeMountRequest,
  response: ServerResponse,
  platform?: NodePlatform,
) => undefined | false | Promise<undefined | false>

interface NodeNativeMountSelection {
  readonly handler: NodeNativeMountHandler
  readonly path: string
  readonly stripPrefix: boolean
}

/**
 * Core's `RawBodyReaders`: the pre-cap reader surface the transport cap buffers through. Mirrored
 * structurally here rather than imported, matching how the rest of this adapter states core's
 * contracts. Handing it over keeps a capped `c.req.json()` on the socket - no undici `Request` is
 * built to read a body this source already knows how to read.
 */
interface NodeRawBodyReaders {
  readonly headers: Pick<Headers, "get">
  readonly body: ReadableStream<Uint8Array> | null
  arrayBuffer(): Promise<ArrayBuffer>
  bytes(): Promise<Uint8Array>
  json(): Promise<unknown>
}

interface NodeContextSet {
  readonly status?: number
  readonly _headers?: Record<string, string>
  readonly _cookies?: string[]
}

interface NodeOutcomeRuntime {
  toOutcome(result: unknown, set: NodeContextSet): NodeServeOutcome
  toResponse(outcome: NodeServeOutcome): Response
  fromResponse(response: Response | NodeResponseResult): NodeServeOutcome
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

const RESOLVE_NODE_MOUNT = Symbol.for(NODE_BRIDGE_MARKER_KEYS.resolveNodeMount)

/**
 * The `Content-Type` the host runtime's `Response.json` emits - Node's undici uses `application/json`,
 * Bun uses `application/json;charset=utf-8`. Probed once at module load (zero per-request cost) so the
 * fast path is byte-for-byte identical to the `Response`-building path on whatever runtime hosts us.
 */
const JSON_CONTENT_TYPE = Response.json(0).headers.get("content-type") ?? "application/json"

const INTERNAL_ERROR_BODY = '{"ok":false,"error":"internal_error"}'
const EMPTY_BUFFER = Buffer.alloc(0)
const NODE_RESPONSE_BODY = Symbol.for(NODE_BRIDGE_MARKER_KEYS.responseBody)
const RESPONSE_RESULT = Symbol.for(NODE_BRIDGE_MARKER_KEYS.responseResult)
/** Core's proof that a header record's names are already the lowercase wire spelling - set once per
 * request by the native response walk, which had to look at the same keys anyway. Declared by key
 * rather than imported: the same cross-package convention as the two marks above. */
const LOWERCASE_HEADER_KEYS = Symbol.for(NODE_BRIDGE_MARKER_KEYS.lowercaseHeaderKeys)

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
      // A plain render never builds a `Response` - same `kind: "json"` lane a handler's return takes.
      const plain = result.plain
      if (plain !== undefined) {
        return {
          kind: "json",
          status: plain.status,
          headers: plainRenderHeaders(plain.headers, set._headers),
          cookies: set._cookies,
          body:
            plain.body === undefined || isBodylessStatus(plain.status)
              ? null
              : JSON.stringify(plain.body),
        }
      }
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
  /** Core's `PlainRender` - a response still in value form, rendered without building a `Response`.
   * Structural, like the rest of this interface: the marker is a `Symbol.for`, so a value from any
   * copy of core matches. */
  readonly plain?: {
    readonly status: number
    readonly headers?: Readonly<Record<string, string>>
    readonly body: unknown
  }
}

/** Mirror of core's `plainRenderHeaders`: the render's own headers on top of `c.set.headers`, always
 * a fresh record when it has any, because the writers below mutate what they are handed and a
 * `status(...)` value is commonly hoisted and reused across requests. */
function plainRenderHeaders(
  own: Readonly<Record<string, string>> | undefined,
  ambient: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (own === undefined) return ambient
  return ambient === undefined ? { ...own } : { ...ambient, ...own }
}

function isResponseResult(value: unknown): value is NodeResponseResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly [RESPONSE_RESULT]?: unknown })[RESPONSE_RESULT] === true &&
    typeof (value as { readonly toResponse?: unknown }).toResponse === "function"
  )
}

interface DeferredBodyView {
  readonly status: number
  readonly headers: Record<string, string>
  readonly body: string
}

/** The native `Response` body-init type, sourced from the constructor (core stays DOM-lib-free). */
type ResponseBodyInit = ConstructorParameters<typeof Response>[0]

/**
 * The content-type a native `new Response(<string>)` infers when the caller sets none. Read off the
 * native `Response` at load (before any patch), so a deferred string body carries the exact same
 * content-type byte for byte as the runtime would have produced. */
const STRING_BODY_CONTENT_TYPE =
  new Response("").headers.get("content-type") ?? "text/plain;charset=UTF-8"

/**
 * The one shape a raw `new Response(...)` can be served from without building the undici `Response`:
 * a string body, no `statusText`, and no headers or a plain-object record of string values (a
 * `Headers` instance, an entries array, a `Map` all fail the prototype check and take the real path).
 * `undefined` means "this needs a real `Response`". A string body with no explicit content-type gets
 * the same one the native constructor would have inferred, so the wire bytes are unchanged.
 */
function deferredBodyView(
  body: ResponseBodyInit,
  init: ResponseInit | undefined,
): DeferredBodyView | undefined {
  if (typeof body !== "string") return undefined
  if (init === undefined || init === null) {
    return { status: 200, headers: { "content-type": STRING_BODY_CONTENT_TYPE }, body }
  }
  if (init.statusText !== undefined) return undefined
  const headers: Record<string, string> = {}
  let hasContentType = false
  const source = init.headers
  if (source !== undefined) {
    const proto = Object.getPrototypeOf(source)
    if (proto !== Object.prototype && proto !== null) return undefined
    for (const name of Object.keys(source)) {
      const value = (source as Record<string, unknown>)[name]
      if (typeof value !== "string") return undefined
      const lower = name.toLowerCase()
      headers[lower] = value
      if (lower === "content-type") hasContentType = true
    }
  }
  if (!hasContentType) headers["content-type"] = STRING_BODY_CONTENT_TYPE
  return { status: init.status ?? 200, headers, body }
}

/**
 * A `Response` stand-in for the opt-in global patch ({@link installFastResponse}). A *simple* `new
 * Response("Hi")` defers exactly like `c.text` does - it carries the `ResponseResult` protocol
 * `toOutcome` prefers, so the reply reaches the writer without a body-stream drain - while anything
 * with a shape only a real `Response` carries (a stream, a `Blob`, `null`, a `Headers` instance)
 * builds one up front, unchanged. Kept here, not imported from core: this adapter depends on core
 * only through the shared `Symbol.for` marks, never a package import.
 */
const DeferringResponse = /* @__PURE__ */ (() => {
  const NativeResponse = globalThis.Response

  class DeferringResponse {
    /** Set from the start for a non-simple body; otherwise built lazily from `#view`. */
    #real: Response | undefined
    /** The direct-write view for a simple body; `undefined` once `#real` exists. */
    #view: DeferredBodyView | undefined

    constructor(body?: ResponseBodyInit, init?: ResponseInit, prebuilt?: DeferredBodyView) {
      // `c.json`/`c.text` reach the fast lane through `fromView`: core has already built the owned,
      // lowercase, content-typed record, so the view is taken as-is - no second header walk.
      if (prebuilt !== undefined) {
        this.#view = prebuilt
        return
      }
      const view = deferredBodyView(body, init)
      if (view === undefined) {
        this.#real = new NativeResponse(body, init)
      } else {
        this.#view = view
      }
    }

    /** A deferred response over an already-built direct-write view - the seam core's `c.json`/`c.text`
     * register (see below), skipping the `deferredBodyView` walk the raw `new Response` patch runs. */
    static fromView(view: DeferredBodyView): Response {
      return new DeferringResponse(undefined, undefined, view) as unknown as Response
    }

    get status(): number {
      return this.#view !== undefined ? this.#view.status : (this.#real as Response).status
    }

    get _real(): Response {
      if (this.#real === undefined) {
        const view = this.#view as DeferredBodyView
        const real = new NativeResponse(view.body, { status: view.status, headers: view.headers })
        // Tag the materialized body so a hook that only read `.headers` still writes bytes without a
        // drain - the same mark `nodeOutcomeFromResponse` reads.
        Object.defineProperty(real, NODE_RESPONSE_BODY, { value: view.body })
        this.#real = real
      }
      return this.#real
    }

    toResponse(): Response {
      return this._real
    }

    toNodeBody(): DeferredBodyView | undefined {
      return this.#real === undefined ? this.#view : undefined
    }
  }

  // Forward every other Response member to the lazily materialized real response; data properties
  // (e.g. Symbol.toStringTag) are reached through the chained prototype without a brand check.
  const own = new Set<string | symbol>([
    "constructor",
    "status",
    "_real",
    "toResponse",
    "toNodeBody",
  ])
  const keys: Array<string | symbol> = [
    ...Object.getOwnPropertyNames(NativeResponse.prototype),
    ...Object.getOwnPropertySymbols(NativeResponse.prototype),
  ]
  for (const key of keys) {
    if (own.has(key)) continue
    const descriptor = Object.getOwnPropertyDescriptor(NativeResponse.prototype, key)
    if (descriptor === undefined) continue
    if (typeof descriptor.value === "function") {
      Object.defineProperty(DeferringResponse.prototype, key, {
        configurable: true,
        writable: true,
        value: function (this: InstanceType<typeof DeferringResponse>, ...args: unknown[]) {
          const real = this._real as unknown as Record<string | symbol, unknown>
          return (real[key] as (...a: unknown[]) => unknown).apply(real, args)
        },
      })
    } else if (descriptor.get !== undefined) {
      Object.defineProperty(DeferringResponse.prototype, key, {
        configurable: true,
        get(this: InstanceType<typeof DeferringResponse>) {
          return (this._real as unknown as Record<string | symbol, unknown>)[key]
        },
      })
    }
  }
  Object.defineProperty(DeferringResponse.prototype, RESPONSE_RESULT, { value: true })
  Object.setPrototypeOf(DeferringResponse.prototype, NativeResponse.prototype)
  // Inherit the native statics (`Response.json` / `redirect` / `error`) so they still resolve after
  // the swap; those build a real `Response` - the deferral is for the constructor path.
  Object.setPrototypeOf(DeferringResponse, NativeResponse)
  // `Response.json(...)` (and a native `Response` some other library built before the swap) returns a
  // native instance, whose prototype sits *above* ours; treat any native `Response` as an instance so
  // `x instanceof Response` stays true across the swap. A deferred instance chains through
  // `NativeResponse.prototype` too, so it also passes.
  Object.defineProperty(DeferringResponse, Symbol.hasInstance, {
    configurable: true,
    value: (instance: unknown): boolean => instance instanceof NativeResponse,
  })
  return DeferringResponse
})()

// Hand core's `c.json`/`c.text` Node fast lane a deferred-response factory over the shared-symbol seam
// (no core import - the same `Symbol.for` convention as the marks above, so core ships none of this
// class in a Bun/Deno bundle). Reuses DeferringResponse from an already-owned header record, so the
// helper skips the header re-walk `deferredBodyView` does for the raw `new Response` patch. `??=`:
// first adapter load wins; a re-import is a no-op.
const DEFERRED_RESPONDER_KEY = Symbol.for("nifra.deferred.responder")
;(globalThis as unknown as Record<symbol, unknown>)[DEFERRED_RESPONDER_KEY] ??= (
  body: string,
  status: number,
  headers: Record<string, string>,
): Response => DeferringResponse.fromView({ status, headers, body })

/**
 * Swap `globalThis.Response` for {@link DeferringResponse}. Idempotent (guarded on identity, so a
 * repeated `serve({ fastResponse: true })` is a no-op) and not auto-restored: the swap is transparent
 * for every construction (simple bodies defer, the rest build a real `Response`), so it can stay in
 * place for the process lifetime once any server opts in.
 */
function installFastResponse(): void {
  if (globalThis.Response === (DeferringResponse as unknown)) return
  globalThis.Response = DeferringResponse as unknown as typeof Response
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

/** Early exits built outside the handler's finalizer - an `onRequest` hook's response, a mount's,
 * every framework error render. A plain-data carrier takes the `kind: "json"` lane a handler's plain
 * return takes, with no `Response` built and none drained; there is no `c.set` at these sites, which
 * is why they are wrapped rather than finalized. */
function nodeOutcomeFromResponse(result: Response | NodeResponseResult): NodeServeOutcome {
  if (!(result instanceof Response)) {
    const plain = result.plain
    if (plain !== undefined) {
      return {
        kind: "json",
        status: plain.status,
        headers: plain.headers === undefined ? undefined : { ...plain.headers },
        cookies: undefined,
        body:
          plain.body === undefined || isBodylessStatus(plain.status)
            ? null
            : JSON.stringify(plain.body),
      }
    }
    return nodeOutcomeFromResponse(result.toResponse())
  }
  const response = normalizeBodylessResponse(result)
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
  /**
   * Make a hand-rolled `return new Response(body)` ride the direct-write lane, by swapping
   * `globalThis.Response` for a stand-in that defers a *simple* construction (a string body, no
   * `statusText`, no headers or a plain header record) the way `c.text` / `c.json` already do.
   *
   * Off by default: prefer `c.text` / `c.json`, which get this without a global swap. Reach for the
   * flag only when handlers construct `Response` by hand on the hot path. It patches a process-global
   * builtin, so every `new Response(...)` anywhere in the process goes through the stand-in -
   * transparent (non-simple bodies build a real `Response`, and simple ones stay `instanceof
   * Response`), but a broad enough change to be opt-in.
   */
  readonly fastResponse?: boolean
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
    // Defense-in-depth: the lexical `..` guard in staticMatch can't catch a symlink INSIDE root that
    // points outside it. Resolve first, check containment on the RESOLVED name, and open that -
    // never open the requested path and re-resolve it afterwards. A local attacker who can write
    // inside the served tree wins that ordering: swap a link between the open and the lookup and the
    // descriptor already streaming refers to an external file while the lookup answers with a
    // contained path. `O_NOFOLLOW` closes the remainder on the final component - `realpath` returned
    // a name with no links left in it, so one appearing before the open is an attack, not a layout.
    const [realFile, realRoot] = await Promise.all([realpath(file), realpath(state.root)])
    if (realFile !== realRoot && !realFile.startsWith(realRoot + sep)) {
      return { kind: "response", response: new Response("Forbidden", { status: 403 }) }
    }
    handle = await open(realFile, FS.O_RDONLY | FS.O_NOFOLLOW)
    const stat = await handle.stat()
    if (!stat.isFile()) {
      await handle.close()
      return { kind: "response", response: new Response("Not Found", { status: 404 }) }
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
      // Claimable rather than `Readable.toWeb`: served straight from disk to the socket when this
      // response reaches the writer untouched, and read as an ordinary Web stream by anything that
      // gets to it first (a middleware that rewrites or compresses the body, say), which refuses
      // the claim and takes the conversion instead.
      response: new Response(claimableWebStream(stream), { headers }),
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
  if (options.fastResponse === true) installFastResponse()
  let inFlight = 0
  let closed = false
  const protocol = protocolResolver(options.protocol)
  const hostPolicy = hostPolicyOf(options)
  const staticState = options.static !== undefined ? staticStateOf(options.static) : undefined
  // Node otherwise destroys a socket as soon as its HTTP parser emits `clientError`. That can
  // discard the response for an already-dispatched request when an understated Content-Length
  // leaves surplus bytes that look like a malformed pipelined request. Keep the parser error
  // connection-scoped and close only after active responses finish, preserving response ordering.
  const activeResponses = new WeakMap<object, Set<ServerResponse>>()
  const parserErrorSockets = new WeakSet<object>()
  const server = createServer((nodeReq, nodeRes) => {
    const socket = nodeReq.socket
    let responses = activeResponses.get(socket)
    if (responses === undefined) {
      responses = new Set<ServerResponse>()
      activeResponses.set(socket, responses)
    }
    responses.add(nodeRes)
    const releaseResponse = (): void => {
      const current = activeResponses.get(socket)
      if (current === undefined) return
      current.delete(nodeRes)
      if (current.size === 0) activeResponses.delete(socket)
    }
    nodeRes.once("finish", releaseResponse)
    nodeRes.once("close", releaseResponse)
    inFlight += 1
    try {
      const handled = handle(app, nodeReq, nodeRes, protocol, staticState, hostPolicy)
      if (handled instanceof Promise) {
        // `catch` before `finally`: a `finally` alone forwards the rejection to a promise nothing
        // observes, and Node terminates the process on an unhandled rejection by default. Every
        // writer already ends its own failures (`failWrite`), so anything arriving here is a fault
        // no response can still be built from - the connection is the only thing left to end.
        void handled
          .catch(() => failWrite(nodeRes))
          .finally(() => {
            inFlight -= 1
          })
        return
      }
      inFlight -= 1
    } catch {
      failWrite(nodeRes)
      inFlight -= 1
    }
  })

  server.on("clientError", (_error, socket) => {
    if (socket.destroyed) return
    const responses = activeResponses.get(socket)
    if (responses !== undefined && responses.size > 0) {
      if (parserErrorSockets.has(socket)) return
      parserErrorSockets.add(socket)
      const closeWhenDrained = (): void => {
        const current = activeResponses.get(socket)
        if (current === undefined || current.size === 0) socket.destroy()
      }
      for (const response of responses) {
        if (response.writableEnded || response.destroyed) closeWhenDrained()
        else response.once("finish", closeWhenDrained)
        response.once("close", closeWhenDrained)
      }
      return
    }
    const body = "Bad Request"
    socket.end(
      `HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    )
  })

  // WebSocket upgrades (a nifra app exposing the seam): handled on the http server's `upgrade` event via
  // the optional `ws` package - lazy-imported (and the server lazily built) on the FIRST real WS
  // upgrade, so a non-WS Node app never loads `ws`.
  const resolveWs = app.resolveWebSocketUpgrade?.bind(app)
  if (resolveWs !== undefined) {
    let wssPromise: Promise<WsServer | undefined> | undefined
    server.on("upgrade", (nodeReq, socket, head) => {
      void handleUpgrade(
        resolveWs,
        protocol,
        hostPolicy,
        nodeReq,
        socket,
        head,
        (maxPayloadBytes) => {
          wssPromise ??= loadWsServer(maxPayloadBytes)
          return wssPromise
        },
      )
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

/** Run the existing Node-direct/Web bridge after a native mount either was not selected or declined
 * because its optional transport was unavailable. Kept as a top-level helper so ordinary requests
 * do not allocate a per-request closure merely to preserve the fallback. */
function runNodeSource(
  app: FetchHandler,
  source: NodeRequestSource,
  nodeReq: IncomingMessage,
  nodeRes: ServerResponse,
  protocol: RequestProtocol,
  host: string,
  platform: NodePlatform | undefined,
): void | Promise<void> {
  const resolveNodeSource = (app as Partial<NodeFastHandler>).resolveNodeSource
  if (typeof resolveNodeSource === "function") {
    try {
      const outcome = resolveNodeSource.call(app, source, platform, NODE_OUTCOME_RUNTIME)
      return outcome instanceof Promise
        ? outcome.then(
            (settled) => writeOutcomeSafely(settled, nodeRes, nodeReq.method),
            () => failWrite(nodeRes),
          )
        : writeOutcomeSafely(outcome, nodeRes, nodeReq.method)
    } catch {
      failWrite(nodeRes)
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
            (settled) => writeOutcomeSafely(settled, nodeRes, nodeReq.method),
            () => failWrite(nodeRes),
          )
        : writeOutcomeSafely(outcome, nodeRes, nodeReq.method)
    } catch {
      failWrite(nodeRes)
      return
    }
  }

  try {
    const response = app.fetch(request, platform)
    return response instanceof Promise
      ? response.then(
          (settled) => writeResponseSafely(settled, nodeRes, nodeReq.method),
          () => failWrite(nodeRes),
        )
      : writeResponseSafely(response, nodeRes, nodeReq.method)
  } catch {
    // The app should never throw (nifra returns a 500), but never leak a stack to the wire.
    failWrite(nodeRes)
    return
  }
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
      if ("reject" in matched) return writeResponseSafely(matched.reject, nodeRes, nodeReq.method)
      return readStatic(matched.file, staticState, nodeReq.method ?? "GET").then(
        (outcome) => writeOutcomeSafely(outcome, nodeRes, nodeReq.method),
        () => failWrite(nodeRes),
      )
    }
  }

  // A mounted handler may advertise a native Node lane. Core has already checked route precedence
  // and every global lifecycle gate before returning this selection. The handler writes directly to
  // `nodeRes`; `false` means its optional transport was unavailable, so the same untouched source
  // continues through the ordinary Web/direct path below.
  const resolveNodeSource = (app as Partial<NodeFastHandler>).resolveNodeSource
  const resolveNodeMount = (app as unknown as Record<symbol, unknown>)[RESOLVE_NODE_MOUNT]
  if (typeof resolveNodeSource === "function" || typeof resolveNodeMount === "function") {
    const nodeSource = toNodeRequestSource(nodeReq, protocol, host)

    if (typeof resolveNodeMount === "function") {
      let selection: NodeNativeMountSelection | undefined
      try {
        selection = (
          resolveNodeMount as (
            source: NodeRequestSource,
            platform?: NodePlatform,
          ) => NodeNativeMountSelection | undefined
        ).call(app, nodeSource, platform)
      } catch {
        writeInternalError(nodeRes)
        return
      }
      if (selection !== undefined) {
        const nativeRequest: NodeNativeMountRequest = {
          method: nodeReq.method ?? "GET",
          url: selection.stripPrefix
            ? stripNodeMountPrefix(`${protocol}://${host}${nodeReq.url ?? "/"}`, selection.path)
            : `${protocol}://${host}${nodeReq.url ?? "/"}`,
          headers: nodeReq.headers,
          raw: nodeReq,
        }
        try {
          const outcome = selection.handler(nativeRequest, nodeRes, platform)
          if (outcome instanceof Promise) {
            return outcome.then(
              (handled) =>
                handled === false
                  ? runNodeSource(app, nodeSource, nodeReq, nodeRes, protocol, host, platform)
                  : undefined,
              () => failWrite(nodeRes),
            )
          }
          if (outcome !== false) return
        } catch {
          failWrite(nodeRes)
          return
        }
      }
    }

    return runNodeSource(app, nodeSource, nodeReq, nodeRes, protocol, host, platform)
  }

  const request = toWebRequest(nodeReq, protocol, host)
  const resolveNode = (app as Partial<NodeFastHandler>).resolveNode
  if (typeof resolveNode === "function") {
    try {
      const outcome = resolveNode.call(app, request, platform)
      return outcome instanceof Promise
        ? outcome.then(
            (settled) => writeOutcomeSafely(settled, nodeRes, nodeReq.method),
            () => failWrite(nodeRes),
          )
        : writeOutcomeSafely(outcome, nodeRes, nodeReq.method)
    } catch {
      failWrite(nodeRes)
      return
    }
  }

  try {
    const response = app.fetch(request, platform)
    return response instanceof Promise
      ? response.then(
          (settled) => writeResponseSafely(settled, nodeRes, nodeReq.method),
          () => failWrite(nodeRes),
        )
      : writeResponseSafely(response, nodeRes, nodeReq.method)
  } catch {
    // The app should never throw (nifra returns a 500), but never leak a stack to the wire.
    failWrite(nodeRes)
    return
  }
}

function writeNodeOutcome(
  outcome: NodeServeOutcome,
  nodeRes: ServerResponse,
  method?: string,
): void | Promise<void> {
  const isHead = method?.toUpperCase() === "HEAD"
  if (outcome.kind === "json") {
    writeJsonOutcome(outcome, nodeRes, isHead)
    return
  }
  if (outcome.kind === "body") {
    writeBodyOutcome(outcome, nodeRes, isHead)
    return
  }
  return writeNodeResponse(outcome.response, nodeRes, method)
}

/** A flat 500 with no leaked detail - the adapter's last-resort guard if a handler throws. */
function writeInternalError(nodeRes: ServerResponse): void {
  nodeRes.writeHead(500, { "content-type": "application/json" })
  nodeRes.end(INTERNAL_ERROR_BODY)
}

/**
 * End a request whose WRITE failed, from anywhere a write can fail.
 *
 * `writeHead` throws on an invalid status or a header value carrying CR/LF - reachable whenever an
 * app reflects request data into `status(...)`/`c.set.headers`, which on the Web lane the `Headers`
 * constructor rejects instead. It also throws once the head is already out. Both have to end here:
 * on the async lanes the write runs inside a `.then` callback whose rejection nothing downstream
 * catches (`serve` only observes `finally`), and Node's default for an unhandled rejection is to
 * terminate the process - a route-shaped input turning into a server-wide DoS.
 *
 * A 500 while the head is unsent, otherwise a destroy: there is no way to correct a response whose
 * status line already shipped, and a half-written body must not be left for the client to parse.
 */
function failWrite(nodeRes: ServerResponse): void {
  try {
    if (!nodeRes.headersSent) {
      writeInternalError(nodeRes)
      return
    }
  } catch {
    // The socket went away between the check and the write; fall through to the destroy.
  }
  nodeRes.destroy()
}

/** {@link writeNodeOutcome} with {@link failWrite} behind it, sync throw and async rejection alike. */
function writeOutcomeSafely(
  outcome: NodeServeOutcome,
  nodeRes: ServerResponse,
  method?: string,
): void | Promise<void> {
  try {
    const written = writeNodeOutcome(outcome, nodeRes, method)
    return written instanceof Promise ? written.catch(() => failWrite(nodeRes)) : written
  } catch {
    failWrite(nodeRes)
    return
  }
}

/** {@link writeNodeResponse} with {@link failWrite} behind it - same contract as
 * {@link writeOutcomeSafely}, for the lanes that carry a `Response`. */
function writeResponseSafely(
  response: Response,
  nodeRes: ServerResponse,
  method?: string,
): void | Promise<void> {
  try {
    const written = writeNodeResponse(response, nodeRes, method)
    return written instanceof Promise ? written.catch(() => failWrite(nodeRes)) : written
  } catch {
    failWrite(nodeRes)
    return
  }
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
  isHead = false,
): void {
  // The outcome's record is the request's own (`c.set.headers`, already mutated by any native
  // response hooks), and its writers - middleware twins and the framework's own additions - emit
  // lowercase names. Confirmed either by core's mark (the native response walk already looked at
  // these keys, so re-walking them here is the same pass twice) or, when the record never went
  // through that walk, by the scan below. Either way the record is then used as-is and the additions
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
  } else if (
    (source as Record<symbol, unknown>)[LOWERCASE_HEADER_KEYS] === true ||
    allHeaderKeysLowercase(source)
  ) {
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
    if (headers["content-type"] === undefined) headers["Content-Type"] = JSON_CONTENT_TYPE
    else {
      headers["Content-Type"] = headers["content-type"]
      delete headers["content-type"]
    }
    headers["Content-Length"] = String(Buffer.byteLength(outcome.body))
    delete headers["content-length"]
  } else if (isBodylessStatus(outcome.status)) {
    // 204/205/304 never carry a payload; discard a user/native-hook length even when the body is
    // already represented as null so the direct writer cannot advertise bytes that will not ship.
    delete headers["content-length"]
    delete headers["Content-Length"]
  } else if (!isHead && headers["content-length"] === undefined) {
    // A body-less render at a status that MAY carry a body - a `redirect()`, above all. Node frames
    // a `writeHead` + bare `end()` as chunked, so the shortest response the framework emits went out
    // with a chunk terminator and no length, where every Web-native runtime sends `content-length: 0`.
    // Declared here so the wire matches them. HEAD is excluded: its length describes the GET's body,
    // which this lane does not know.
    headers["Content-Length"] = "0"
  }
  if (outcome.cookies !== undefined && outcome.cookies.length > 0) {
    headers["set-cookie"] = [...outcome.cookies]
  }
  nodeRes.writeHead(outcome.status, headers)
  if (isHead || outcome.body === null) {
    nodeRes.end()
  } else {
    nodeRes.end(outcome.body)
  }
}

/**
 * Write a node-direct buffered body outcome straight to the socket. This is the Response-shaped
 * sibling of `writeJsonOutcome`: headers/status were already normalized by core, and the body is the
 * exact marked payload from the Response producer, so there is no Web body reader to drain.
 */
function writeBodyOutcome(
  outcome: Extract<NodeServeOutcome, { kind: "body" }>,
  nodeRes: ServerResponse,
  isHead = false,
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
  if (isHead) nodeRes.end()
  else nodeRes.end(outcome.body)
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

function stripNodeMountPrefix(url: string, prefix: string): string {
  if (prefix === "/") return url
  const target = new URL(url)
  const rest = target.pathname.slice(prefix.length)
  target.pathname = rest === "" ? "/" : rest
  return target.href
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

/** An `ArrayBuffer` spanning exactly the view - Node hands back pooled buffers, so a caller that
 * receives the raw `.buffer` would see (and could reach into) unrelated requests' bytes. */
function detachedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function parseJsonBytes(bytes: Uint8Array): unknown {
  const buffer = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return JSON.parse(buffer.toString("utf8")) as unknown
}

/** A one-chunk stream replaying already-buffered bytes. `highWaterMark: 0` keeps construction free
 * of a pull, and the copy keeps the shared buffer out of a consumer's reach. */
function streamOfBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.enqueue(bytes.slice())
        controller.close()
      },
    },
    { highWaterMark: 0 },
  )
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
  private rawReaders: NodeRawBodyReaders | undefined
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
    this.bodyValue ??= claimableWebStream(this.nodeReq, "drain")
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

  /**
   * The transport cap's pre-shadow readers. Header probes hit Node's already-lowercased bag instead
   * of building a `Headers`, and the byte readers buffer the socket directly - so a capped
   * `c.req.json()` never materializes the undici `Request` this source is still deferring. `body`
   * stays the live stream, so core's streaming guard still aborts a chunked body mid-flight rather
   * than buffering it first.
   */
  rawBodyReaders(): NodeRawBodyReaders {
    const source = this
    this.rawReaders ??= {
      headers: { get: (name: string) => source.header(name) },
      get body(): ReadableStream<Uint8Array> | null {
        return source.rawBodyStream()
      },
      arrayBuffer: () => source.rawBodyBytes().then(detachedArrayBuffer),
      bytes: () => source.rawBodyBytes(),
      json: () => source.rawBodyBytes().then(parseJsonBytes),
    }
    return this.rawReaders
  }

  /**
   * Body bytes for the transport cap, straight off the socket. Once the Web `Request` already owns
   * the stream (a hook that read `c.req.signal` materialized it before any body read), draining that
   * stream is the only safe source - re-listening on the node request would split the body in two.
   */
  private rawBodyBytes(): Promise<Uint8Array> {
    if (this.consumedBody !== undefined) return Promise.resolve(this.consumedBody)
    const handed = this.bodyValue
    if (handed != null) {
      return new Response(handed).arrayBuffer().then((buffer) => new Uint8Array(buffer))
    }
    return this.readNodeBody()
  }

  /**
   * The raw body stream, never routed back through `this.request` - post-cap that getter is the
   * shadowed one, which reads back through these very readers. An already-consumed body replays
   * from its buffer, matching the cap's own replay-instead-of-fail contract.
   */
  private rawBodyStream(): ReadableStream<Uint8Array> | null {
    if (this.method === "GET" || this.method === "HEAD") return null
    const consumed = this.consumedBody
    if (consumed !== undefined) return streamOfBytes(consumed)
    this.bodyValue ??= claimableWebStream(this.nodeReq, "drain")
    return this.bodyValue
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
    init.body = body ?? claimableWebStream(req, "drain")
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

function writeNodeResponse(
  response: Response,
  nodeRes: ServerResponse,
  method?: string,
): void | Promise<void> {
  const isHead = method?.toUpperCase() === "HEAD"
  // `ServerResponse.setHeaders` (Node 18.14+) takes the Headers object directly and iterates its
  // native Symbol.iterator, which - unlike `Headers.forEach`/`.get()` - never comma-joins repeated
  // `Set-Cookie` values (Node's own implementation carries the identical correctness note this
  // function used to hand-implement via `getSetCookie()`). One native call instead of a manual
  // forEach into a fresh plain object plus a second cookie-specific pass. Must run before
  // `writeHead`: headers are already flushed by the time `writeHead` returns.
  nodeRes.setHeaders(response.headers)
  if (isHead) {
    nodeRes.writeHead(response.status)
    nodeRes.end()
    return
  }
  const directBody = nodeResponseBody(response)
  if (directBody !== undefined) {
    // Node computes the length itself for `end(data)` while the header is still unflushed, so this
    // lane already declares one. The three below do not get that for free.
    nodeRes.writeHead(response.status)
    nodeRes.end(directBody)
    return
  }
  // `end()` with no data is framed as chunked instead, so a body-less `Response` - a hand-rolled
  // redirect, above all - went out with a chunk terminator and no length where every Web-native
  // runtime sends `content-length: 0`. Declared before `writeHead`, the last point a header can
  // still be added. Excluded: HEAD, whose length describes the GET's body that this lane does not
  // know; a status that cannot carry a body; and a length the caller set for itself.
  const canDeclareLength =
    !isBodylessStatus(response.status) && !response.headers.has("content-length")
  if (response.body === null) {
    if (canDeclareLength) nodeRes.setHeader("content-length", "0")
    nodeRes.writeHead(response.status)
    if (!nodeRes.destroyed && !nodeRes.writableEnded && nodeRes.writable) nodeRes.end()
    return
  }
  // A body that is a Web view over a Node stream (an upstream response relayed by
  // `@nifrajs/proxy/undici`, say) goes to the socket as the Node stream it already is, skipping the
  // per-chunk trip through Web objects that the reader loop below pays for. Length is the upstream's
  // business: it either forwarded a `content-length` or is genuinely streaming.
  const nodeBody = response.bodyUsed ? null : claimNodeStream(response.body)
  if (nodeBody !== null) {
    nodeRes.writeHead(response.status)
    return pipeNodeResponseBody(nodeBody, nodeRes)
  }
  return writeNodeResponseBody(response, nodeRes, canDeclareLength)
}

/**
 * Send a claimed Node body straight to the socket.
 *
 * `pipe` rather than `pipeline`: the status line is already flushed by here, so the only teardown
 * still available is a destroy on both ends, and `pipeline`'s per-request `eos` machinery costs
 * more than it buys at this point - it measured as a net loss against the Web reader loop it
 * replaces, where plain `pipe` measured as a win on both GET and POST.
 *
 * The two destroys below are belt-and-braces, not the mechanism: for a body claimed from
 * `@nifrajs/proxy`, the request's abort signal already tears the upstream down when the client
 * hangs up, and an upstream that dies mid-body already reaches the client as a broken transfer
 * rather than a short `200`. They are kept because `pipe` itself guarantees neither, and the claim
 * seam is open to any transport - including one that wires no signal.
 */
function pipeNodeResponseBody(body: Readable, nodeRes: ServerResponse): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      if (!body.destroyed) body.destroy()
      resolve()
    }
    // Attached before anything here can destroy `body`, and with `on` rather than `once`, because
    // destroying an upstream body emits `error` (undici raises `RequestAbortedError` for a request
    // cut short) and an unhandled `error` on a Node stream terminates the process. Every path below
    // ends in a destroy, including the ones that run after this listener has already fired once.
    body.on("error", () => {
      // Only meaningful before the response completes; afterwards there is nothing left to abort.
      if (!settled && !nodeRes.destroyed && !nodeRes.writableEnded) nodeRes.destroy()
      done()
    })
    // The client is already gone: `pipe` would wait on `close`/`finish` that have both fired.
    if (nodeRes.destroyed || nodeRes.writableEnded || !nodeRes.writable) {
      done()
      return
    }
    nodeRes.once("close", done)
    nodeRes.once("finish", done)
    body.pipe(nodeRes)
  })
}

/** The two Web-stream shapes the body lane below needs, named structurally: this package builds
 * without the DOM lib, so `ReadableStreamReadResult` is not a name it can refer to. */
type BodyChunk =
  | { readonly done: false; readonly value: Uint8Array }
  | { readonly done: true; readonly value?: undefined }
type BodyReader = { read(): Promise<BodyChunk>; cancel(): Promise<void> }

/**
 * Send a Web `ReadableStream` body to the socket, declaring a length when the body turns out to be
 * one already-complete chunk.
 *
 * `new Response("hi")` hands its bytes over as a stream, exactly as a live producer does, so the
 * framing decision looks identical from here and Node picks chunked for both. The two are told apart
 * by reading one chunk and then giving the stream a microtask to say it is done: a source-backed body
 * - a string, a `Uint8Array`, a `Blob` - has already enqueued everything and closes inside it, while
 * a producer still generating does not.
 *
 * What is held is one chunk, never the whole body, so a large or endless stream is unaffected in
 * memory. What is spent is a microtask, and it costs a streaming response no bytes on the wire: Node
 * does not flush the header until the first write either way, so nothing was going out during it.
 */
async function writeNodeResponseBody(
  response: Response,
  nodeRes: ServerResponse,
  canDeclareLength: boolean,
): Promise<void> {
  const reader = response.body!.getReader()
  let first: BodyChunk
  try {
    first = await reader.read()
  } catch {
    await reader.cancel().catch(() => {})
    if (!nodeRes.headersSent) writeInternalError(nodeRes)
    else nodeRes.destroy()
    return
  }
  if (first.done) {
    if (canDeclareLength) nodeRes.setHeader("content-length", "0")
    nodeRes.writeHead(response.status)
    if (!nodeRes.destroyed && !nodeRes.writableEnded && nodeRes.writable) nodeRes.end()
    return
  }
  // Attached with `then` rather than awaited: the point is to observe whether it has settled by the
  // end of this turn, not to wait for it. The rejection handler is only here so a body that fails
  // between the two reads is not an unhandled rejection - the drain below awaits the same promise
  // and is where that failure is actually handled.
  const pending = reader.read()
  let settled: BodyChunk | undefined
  pending.then(
    (value) => {
      settled = value
    },
    () => {},
  )
  // A microtask, not a turn of the event loop. It is enough - a source-backed body has already
  // enqueued everything, so its close is a microtask away on Node and two on Bun, both of which this
  // covers - and it is short enough to leave the socket's write order alone: yielding a whole turn
  // here wedged a pipelined keep-alive connection under Bun's `node:http` shim, where the second
  // response never reached the wire.
  await new Promise<void>((resolve) => queueMicrotask(resolve))
  if (settled?.done === true && canDeclareLength && ArrayBuffer.isView(first.value)) {
    nodeRes.setHeader("content-length", String(first.value.byteLength))
    nodeRes.writeHead(response.status)
    if (!nodeRes.destroyed && !nodeRes.writableEnded && nodeRes.writable) nodeRes.end(first.value)
    return
  }
  nodeRes.writeHead(response.status)
  return drainWebResponseBody(reader, nodeRes, first.value, pending)
}

/** The streaming half of {@link writeNodeResponseBody}, resumed from the chunk and the outstanding
 * read the length probe already took off the stream. */
async function drainWebResponseBody(
  reader: BodyReader,
  nodeRes: ServerResponse,
  firstChunk: Uint8Array,
  pending: Promise<BodyChunk>,
): Promise<void> {
  let chunk: Uint8Array | undefined = firstChunk
  let outstanding: Promise<BodyChunk> | undefined = pending
  try {
    for (;;) {
      if (!nodeRes.write(chunk)) {
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
      const result = await (outstanding ?? reader.read())
      outstanding = undefined
      if (result.done) break
      chunk = result.value
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

type WsServerCtor = new (options: { noServer: true; maxPayload?: number }) => WsServer

/** A non-literal specifier so TS treats `import(...)` as `any` - `ws` is an optional peer with no
 * `@types/ws` dependency here (the surface is structurally typed via {@link WsServer}/{@link WsSocket}). */
const WS_MODULE_SPECIFIER = "ws"

/** Lazily build a noServer `ws` `WebSocketServer`, or `undefined` if `ws` isn't installed. */
async function loadWsServer(maxPayloadBytes?: number): Promise<WsServer | undefined> {
  try {
    const mod = (await import(WS_MODULE_SPECIFIER)) as {
      WebSocketServer?: WsServerCtor
      default?: { WebSocketServer?: WsServerCtor }
    }
    const Ctor = mod.WebSocketServer ?? mod.default?.WebSocketServer
    return Ctor === undefined
      ? undefined
      : new Ctor(
          maxPayloadBytes === undefined
            ? { noServer: true }
            : { noServer: true, maxPayload: maxPayloadBytes },
        )
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
  getWss: (maxPayloadBytes?: number) => Promise<WsServer | undefined>,
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
  const wss = await getWss(outcome.maxPayloadBytes)
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
