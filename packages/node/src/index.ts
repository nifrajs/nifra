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
import { createHash } from "node:crypto"
import { type FileHandle, realpath } from "node:fs/promises"
import {
  createServer,
  type IncomingHttpHeaders,
  IncomingMessage,
  type ServerResponse,
  STATUS_CODES,
} from "node:http"
import { createServer as createHttpsServer } from "node:https"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { type Duplex, Readable } from "node:stream"
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web"
import type { TlsOptions } from "node:tls"
import { fileURLToPath } from "node:url"
// srvx's lazy spec-shaped Response - see nodeOutcomeToResponse for why the bridge uses it.
import { FastResponse } from "srvx/node"
import { type BodyReadState, NodeBodyRead } from "./body-read.ts"
import { NODE_BRIDGE_MARKER_KEYS } from "./generated/bridge-markers.ts"
import { jsonText } from "./generated/json-text.ts"
import type { NodeServeOutcome } from "./generated/node-outcome.ts"
import { parseByteRange } from "./generated/range.ts"
import { plainRenderHeaders } from "./generated/render-headers.ts"
import { needsResolving, resolveDotSegments } from "./generated/request-target.ts"
import { RESPONSE_OWNED_HEADERS } from "./generated/response-owned-headers.ts"
import {
  CONTENT_SNAPSHOT_MAX,
  contentTags,
  isHiddenPath,
  matchStatic,
  planStatic,
  type ServeStaticOptions,
  type StaticMount,
  staticMountsOf,
} from "./generated/static-file.ts"
import { assertCloseArgs } from "./generated/ws-close.ts"
import type { NifraWs, NifraWsData, WsUpgradeOutcome } from "./generated/ws-types.ts"
import { claimableWebStream, claimNodeStream } from "./node-stream.ts"
import { openResolved } from "./open-resolved.ts"
import { writeTextFrame } from "./ws-frame.ts"

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
  resolveWebSocketUpgrade?(
    request: Request,
    platform?: NodePlatform,
  ): WsUpgradeOutcome | Promise<WsUpgradeOutcome>
}

/** Structural view of the `ws` package's `WebSocket` (no `@types/ws` dependency - see `loadWsServer`). */
interface WsSocket {
  send(data: string | ArrayBufferView | ArrayBuffer): void
  close(code?: number, reason?: string): void
  terminate(): void
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
/** Agrees with core's `SERVER_LIFECYCLE` by the string alone; the stop tests fail on drift. */
const SERVER_LIFECYCLE = Symbol.for("@nifrajs/core/server-lifecycle")

/** The app's stop hooks when it is a nifra server; a plain `{ fetch }` handler has none. */
function lifecycleOf(app: object): (phase: "stopping" | "stopped") => Promise<void> {
  const run: unknown = Reflect.get(app, SERVER_LIFECYCLE)
  return typeof run === "function"
    ? async (phase) => {
        await Reflect.apply(run, app, [phase])
      }
    : async () => {}
}

/**
 * The `Content-Type` the host runtime's `Response.json` emits - Node's undici uses `application/json`,
 * Bun uses `application/json;charset=utf-8`. Probed once at module load (zero per-request cost) so the
 * fast path is byte-for-byte identical to the `Response`-building path on whatever runtime hosts us.
 */
const JSON_CONTENT_TYPE = Response.json(0).headers.get("content-type") ?? "application/json"

const INTERNAL_ERROR_BODY = '{"ok":false,"error":"internal_error"}'
/** A handler's Response whose body was already sent: refused, since its headers were written for the
 * request it already answered. */
const SENT_BODY_OUTCOME: NodeServeOutcome = Object.freeze({
  kind: "json",
  status: 500,
  headers: undefined,
  cookies: undefined,
  body: INTERNAL_ERROR_BODY,
})
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
              : jsonText(plain.body),
        }
      }
      const body = result.toNodeBody?.()
      if (body !== undefined) {
        return {
          kind: "body",
          status: body.status,
          headers: applySetToNodeHeaders(body.headers, body.status, set),
          body: isBodylessStatus(body.status) ? new Uint8Array(0) : body.body,
        }
      }
      return nodeOutcomeFromResponse(applySetToResponse(result.toResponse(), set))
    }
    if (result instanceof Response) {
      if (result.bodyUsed) return SENT_BODY_OUTCOME
      return nodeOutcomeFromResponse(applySetToResponse(result, set))
    }
    const status = set.status ?? (result === undefined ? 204 : 200)
    const body = result === undefined || isBodylessStatus(status) ? null : jsonText(result)
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
      const created = new DeferringResponse(undefined, undefined, view)
      const deferred: unknown = created
      return deferred as Response
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
  forwardToReal(DeferringResponse.prototype, NativeResponse.prototype, own)
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
;(globalThis as Record<symbol, unknown>)[DEFERRED_RESPONDER_KEY] ??= (
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
  const deferredResponse: unknown = DeferringResponse
  globalThis.Response = deferredResponse as typeof Response
}

/**
 * `response` with this request's `c.set` headers it lacks and its queued cookies - core's
 * `applySetToResponse` and `writableResponse` rules, mirrored. A Response without a body can be sent
 * any number of times, so the object a handler returns may answer other requests too and is always
 * copied; one with a body can be sent once, so it is this request's and takes the writes in place
 * unless its `Headers` are guarded (`Response.redirect()`, a raw `fetch()` result).
 */
function applySetToResponse(response: Response, set: NodeContextSet): Response {
  const ambient = response.status >= 200 ? set._headers : undefined
  const cookies = set._cookies ?? []
  const added: Array<readonly [string, string]> = []
  if (ambient !== undefined) {
    for (const name in ambient) {
      if (RESPONSE_OWNED_HEADERS.has(name.toLowerCase()) || response.headers.has(name)) continue
      added.push([name, ambient[name]!])
    }
  }
  if (added.length === 0 && cookies.length === 0) return response
  const write = (target: Response): Response => {
    for (const [name, value] of added) target.headers.set(name, value)
    for (const cookie of cookies) target.headers.append("set-cookie", cookie)
    return target
  }
  if (response.body === null && response.status >= 200) {
    return write(
      copiedResponse(
        response,
        new Response(null, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        }),
      ),
    )
  }
  try {
    return write(response)
  } catch {
    // Guarded `Headers` reject every write, so the first one throws with nothing applied and the
    // writes land on a mutable copy instead.
    return write(copiedResponse(response, new Response(response.body, response)))
  }
}

/** `copy` carrying `original`'s buffered-body marker, so the direct writer still sends those bytes. */
function copiedResponse(original: Response, copy: Response): Response {
  const body: unknown = Reflect.get(original, NODE_RESPONSE_BODY)
  if (body !== undefined) Object.defineProperty(copy, NODE_RESPONSE_BODY, { value: body })
  return copy
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
          plain.body === undefined || isBodylessStatus(plain.status) ? null : jsonText(plain.body),
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
  const body =
    isBodylessStatus(outcome.status) || outcome.body === null
      ? null
      : typeof outcome.body === "string"
        ? outcome.body
        : outcome.body.slice()
  const response = new FastResponse(body, {
    status: outcome.status,
    headers: pairs,
  }) as Response
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

/** {@link applySetToResponse} for a body the direct writer sends from a header record. */
function applySetToNodeHeaders(
  headers: Readonly<Record<string, string | readonly string[]>> | undefined,
  status: number,
  set: NodeContextSet,
): Readonly<Record<string, string | readonly string[]>> | undefined {
  const ambient = status >= 200 ? set._headers : undefined
  const cookies = set._cookies
  const copy = (): Record<string, string | readonly string[]> =>
    Object.assign(Object.create(null) as Record<string, string | readonly string[]>, headers)
  let out: Record<string, string | readonly string[]> | undefined
  if (ambient !== undefined) {
    let own: Set<string> | undefined
    for (const name in ambient) {
      const lower = name.toLowerCase()
      if (RESPONSE_OWNED_HEADERS.has(lower)) continue
      own ??= new Set(
        headers === undefined ? [] : Object.keys(headers).map((key) => key.toLowerCase()),
      )
      if (own.has(lower)) continue
      own.add(lower)
      out ??= copy()
      out[name] = ambient[name]!
    }
  }
  if (cookies === undefined || cookies.length === 0) return out ?? headers
  out ??= copy()
  const existing = out["set-cookie"]
  const setCookies =
    existing === undefined ? [] : typeof existing === "string" ? [existing] : [...existing]
  out["set-cookie"] = [...setCookies, ...cookies]
  return out
}

export type { HashedFiles, ServeStaticOptions } from "./generated/static-file.ts"

export interface ServeOptions {
  readonly port: number
  readonly hostname?: string
  /**
   * Protocol used when the adapter constructs `Request.url`.
   *
   * The default is `"https"` when {@link ServeOptions.tls} is set and `"http"` otherwise. Deployments
   * behind TLS termination can set `"https"` (or a trusted infra-aware function) so app code that reads
   * `request.url` sees the public scheme. Forwarded headers are not trusted implicitly.
   */
  readonly protocol?: RequestProtocolOption
  /**
   * Serve HTTPS directly, with no proxy in front: `{ cert, key }` as PEM text or the files' bytes
   * (`readFileSync("cert.pem")`), plus any other `node:tls` server option (`passphrase`, `ca`,
   * `requestCert` for client certificates, `minVersion`, `SNICallback`, ...). Unset, the server speaks
   * plain HTTP, which is what a proxy or platform that terminates TLS expects.
   */
  readonly tls?: TlsOptions
  /** Reject requests whose normalized Host authority is not in this allowlist or callback result. */
  readonly allowedHosts?: readonly string[] | ((host: string) => boolean)
  /** Use this validated authority when constructing Request.url, ignoring the inbound Host value. */
  readonly canonicalHost?: string
  /**
   * Install SIGTERM/SIGINT handlers that call `stop()` for a graceful drain on
   * `docker stop` / Ctrl-C. Off by default - taking over process signals is opt-in, as
   * `server({ gracefulSignals })` is for Bun's `listen()`. The object form is passed to `stop()`.
   *
   * The app-level request timeout (`server({ requestTimeoutMs })` → 503) and body cap
   * are *not* set here - they live inside `app.fetch`, so they already apply through
   * this adapter. Slow-client protection is Node's built-in `requestTimeout` (300s) /
   * `headersTimeout` (60s) defaults.
   */
  readonly gracefulSignals?: boolean | NodeStopOptions
  /**
   * Sees every request before the app does, so a file it answers wins over any route at the same
   * path. It returns the file's response, or `undefined` to let the app route the request. No hook
   * of the app runs for a request it answers. The same option as Bun's `app.listen()` and
   * `@nifrajs/deno`'s `serve()`.
   *
   * {@link serveStatic} is the one to pass for files on disk: this adapter runs its mounts on Node's
   * own request, so a request they pass on keeps the app's direct lane. Any other function needs a
   * Web `Request` for every request, which roughly doubles the cost of a small route.
   */
  readonly static?: (request: Request) => Response | Promise<Response | undefined> | undefined
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

/** How `stop()` winds the server down; the same shape as nifra's Bun `stop()` takes. */
export interface NodeStopOptions {
  /** How long in-flight requests get to finish before the stop forces them closed. Default 10_000. */
  readonly drainMs?: number
  /**
   * How long the server keeps serving after `stop()` began, before it stops accepting connections:
   * the time a load balancer takes to see readiness fail. Default 0.
   */
  readonly delayMs?: number
}

export interface NodeServer {
  /** The bound port (resolved when `port: 0` is requested). */
  readonly port: number
  /**
   * Run the app's `onStopping` hooks, keep serving for `delayMs`, then stop accepting connections,
   * let in-flight requests drain (up to `drainMs`), force-close stragglers + idle keep-alives, and
   * run the app's `onStop` hooks. Open WebSockets get a 1001 close when the drain starts and are
   * terminated if still open at the deadline. Mirrors nifra's Bun `stop()`.
   */
  stop(options?: NodeStopOptions): Promise<void>
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
    // `[1:2]` passes the character test, but no URL can be built on it.
    if (!URL.canParse(`http://${hostname}/`)) return undefined
  } else {
    const colon = value.indexOf(":")
    if (colon === -1) {
      hostname = value
    } else {
      if (value.indexOf(":", colon + 1) !== -1) return undefined
      hostname = value.slice(0, colon)
      port = value.slice(colon + 1)
    }
    // `_` is a legal reg-name character (RFC 3986) and common in container service names.
    if (hostname.length === 0 || !/^[\w.-]+$/.test(hostname)) return undefined
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

/** `headers.host` read from `rawHeaders`: the `headers` getter builds every header into an object,
 * a cost a request that reads no other header would otherwise pay just for Host. `null` when Host
 * repeats: `joinDuplicateHeaders` would hand the app both authorities while this routes on one, and
 * RFC 9112 section 3.2 answers such a request 400, as Deno does. */
function rawHost(req: Pick<IncomingMessage, "rawHeaders">): string | null | undefined {
  const raw = req.rawHeaders
  let host: string | undefined
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i] as string
    if (
      name === "host" ||
      name === "Host" ||
      (name.length === 4 && name.toLowerCase() === "host")
    ) {
      if (host !== undefined) return null
      host = raw[i + 1]
    }
  }
  return host
}

// The `headers` getter merges the first `kHeadersCount` entries of `rawHeaders` (a lowered
// `maxHeadersCount` stops it short of the list) into the object it keeps under `kHeaders`. Both are
// private symbols, found once here. Bun's `node:http` names them too but leaves the count at 0 and
// Deno's builds the object up front, so a scan runs only where the count covers every raw entry.
const INCOMING_SLOTS = ((): { readonly count: symbol; readonly built: symbol } | undefined => {
  try {
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the constructor only stores the socket, so a socketless message is safe to probe for its slot symbols.
    const symbols = Object.getOwnPropertySymbols(new IncomingMessage(null as never))
    const count = symbols.find((symbol) => symbol.description === "kHeadersCount")
    const built = symbols.find((symbol) => symbol.description === "kHeaders")
    return count === undefined || built === undefined ? undefined : { count, built }
  } catch {
    return undefined
  }
})()

/** `key` and `name` are one header name: equal but for ASCII letter case. Same lengths assumed. */
function sameHeaderName(key: string, name: string): boolean {
  for (let i = 0; i < name.length; i++) {
    const a = key.charCodeAt(i)
    const b = name.charCodeAt(i)
    if (a !== b) {
      const folded = b | 32
      if ((a | 32) !== folded || folded < 97 || folded > 122) return false
    }
  }
  return true
}

/**
 * One request header as `headers[name]` gives it, repeats joined with ", " like `Headers.get`. The
 * getter builds every header into an object up front (2.9% of a real-world POST's CPU); seven reads
 * scanning `rawHeaders` instead measured 124-222 ns cheaper. A repeated name, more than 32 headers,
 * or an object already built takes the getter, so Node's merge rules stay the only ones.
 */
function nodeRequestHeader(req: IncomingMessage, name: string): string | null {
  // biome-ignore lint/plugin/noChainedTypeAssertions lint/plugin/requireSafetyCommentForTypeAssertion: reads only the two slot symbols found above, and only `typeof`/`!= null` checks touch them.
  const slots = req as unknown as Record<symbol, unknown>
  const count =
    INCOMING_SLOTS === undefined || slots[INCOMING_SLOTS.built] != null
      ? undefined
      : slots[INCOMING_SLOTS.count]
  const raw = req.rawHeaders
  if (typeof count === "number" && count <= 64 && count === raw.length) {
    let found: string | undefined
    let repeated = false
    for (let i = 0; i < count; i += 2) {
      const key = raw[i]
      if (key?.length !== name.length || (key !== name && !sameHeaderName(key, name))) continue
      if (found !== undefined) {
        repeated = true
        break
      }
      found = raw[i + 1]
    }
    if (!repeated) return found ?? null
  }
  const value = req.headers[name.toLowerCase()]
  if (value === undefined) return null
  return Array.isArray(value) ? value.join(", ") : value
}

function requestHost(req: IncomingMessage, policy: HostPolicy): string | undefined {
  const host = rawHost(req)
  if (host === null) return undefined
  const normalized = normalizeHostCached(host ?? "localhost")
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

/** A mount's directory as this adapter reads it. */
function rootOf(dir: string | URL): string {
  return resolve(typeof dir === "string" ? dir : fileURLToPath(dir))
}

/** The request target as sent, without its query. */
function staticPathOf(url: string): string {
  const query = url.indexOf("?")
  return query === -1 ? url : url.slice(0, query)
}

function refusalOf(status: 400 | 403 | 404): Response {
  return new Response(status === 400 ? "Bad Request" : status === 403 ? "Forbidden" : "Not Found", {
    status,
  })
}

/** The answer a mount gives a path it took but cannot serve, or `undefined` to pass it on. */
function staticRefusal(mount: StaticMount, status: 403 | 404): Response | undefined {
  return mount.fallthrough ? undefined : refusalOf(status)
}

// One per process: the tag of a file served from any mount is remembered by its real path.
const STATIC_TAGS = contentTags(createHash)

function headerOf(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name]
  return typeof value === "string" ? value : null
}

// Up to this many bytes are read whole through the pinned descriptor and written in one call, with
// no Response or stream; a larger body streams from the descriptor. The same cut as Bun's reader.
const STATIC_BUFFERED_MAX = CONTENT_SNAPSHOT_MAX

/** `length` bytes of `handle` from `start`; fewer when the file shrank since its stat. */
async function readPinned(handle: FileHandle, start: number, length: number): Promise<Uint8Array> {
  const bytes = Buffer.allocUnsafe(length)
  let filled = 0
  while (filled < length) {
    const { bytesRead } = await handle.read(bytes, filled, length - filled, start + filled)
    if (bytesRead === 0) break
    filled += bytesRead
  }
  return filled === length ? bytes : bytes.subarray(0, filled)
}

type StaticOutcome = Exclude<NodeServeOutcome, { readonly kind: "json" }>

/**
 * The answer for `rel` under `mount`, or `undefined` when the mount falls through on a file it cannot
 * serve.
 */
async function readStatic(
  mount: StaticMount,
  rel: string,
  immutable: boolean,
  method: "GET" | "HEAD",
  requestHeaders: IncomingHttpHeaders,
): Promise<StaticOutcome | undefined> {
  const missing = (status: 403 | 404 = 404): StaticOutcome | undefined => {
    const response = staticRefusal(mount, status)
    return response === undefined ? undefined : { kind: "response", response }
  }
  const file = resolve(mount.root, rel)
  // A drive or root in the decoded name (`C:/x` on Windows) leaves the directory without a `..`.
  const contained = relative(mount.root, file)
  if (contained.startsWith("..") || isAbsolute(contained)) return missing(403)
  let handle: FileHandle | undefined
  try {
    // Defense-in-depth: the lexical `..` guard in matchStatic can't catch a symlink INSIDE root that
    // points outside it. Resolve first, check containment on the RESOLVED name, and open that -
    // never open the requested path and re-resolve it afterwards. A local attacker who can write
    // inside the served tree wins that ordering: swap a link between the open and the lookup and the
    // descriptor already streaming refers to an external file while the lookup answers with a
    // contained path. openResolved closes the remainder - `realpath` returned a name with no links
    // left in it, so one appearing in any component before the open is an attack, not a layout.
    const [realFile, realRoot] = await Promise.all([realpath(file), realpath(mount.root)])
    // A link out of root, or a visible name linking to a dotfile inside it, answers as a missing file
    // does: unlike a `..` in the request, the name exists, and a distinct status would say so.
    if (realFile !== realRoot && !realFile.startsWith(realRoot + sep)) return missing()
    if (mount.denyDotfiles && isHiddenPath(realFile.slice(realRoot.length + 1))) return missing()
    const opened = await openResolved(realFile)
    handle = opened
    const stat = await opened.stat()
    if (!stat.isFile()) {
      await opened.close()
      return missing()
    }
    let whole: Uint8Array | undefined
    const plan = await planStatic(
      mount,
      immutable,
      { method, header: (name) => headerOf(requestHeaders, name) },
      {
        path: realFile,
        version: stat,
        readWhole: async () => {
          whole = await readPinned(opened, 0, stat.size)
          return whole
        },
        restat: () => opened.stat(),
        tags: STATIC_TAGS,
        parseRange: parseByteRange,
      },
    )
    if (!plan.body) {
      await opened.close()
      return { kind: "body", status: plan.status, headers: plan.headers, body: "" }
    }
    const { start, length, headers } = plan
    if (length <= STATIC_BUFFERED_MAX) {
      const body =
        whole === undefined
          ? await readPinned(opened, start, length)
          : whole.subarray(start, start + length)
      await opened.close()
      headers["content-length"] = String(body.byteLength)
      return { kind: "body", status: plan.status, headers, body }
    }
    // Bounded by the stat's length even for a whole file: one that grew since would overrun its
    // content-length.
    const stream = opened.createReadStream({ start, end: start + length - 1 })
    return {
      kind: "response",
      // Claimable rather than `Readable.toWeb`: served straight from disk to the socket when this
      // response reaches the writer untouched, and read as an ordinary Web stream by anything that
      // gets to it first (a middleware that rewrites or compresses the body, say), which refuses
      // the claim and takes the conversion instead.
      response: new Response(claimableWebStream(stream), { status: plan.status, headers }),
    }
  } catch {
    await handle?.close().catch(() => {})
    // Missing or unreadable under the prefix: a 404 (not an SSR 404 page), unless the mount falls through.
    return missing()
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
// A nifra server logs what an adapter reports through this seam, as Bun's `listen()` does; a plain
// `{ fetch }` handler has no logger, so its failures stay a bare 500.
const REPORT_ERROR = Symbol.for("@nifrajs/core/report-error")
function errorReporterOf(app: FetchHandler): ((error: unknown) => void) | undefined {
  const report: unknown = Reflect.get(app, REPORT_ERROR)
  return typeof report === "function" ? (error) => report.call(app, error) : undefined
}

function enableNodeDirect(app: FetchHandler): void {
  const appProperties: unknown = app
  const install = (appProperties as Record<symbol, unknown>)[INSTALL_NODE_DIRECT]
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

/** The served app's own error log, kept on the server so a response carries no per-request state. */
const ERROR_REPORTER = Symbol("nifra.node.error-reporter")
type ReportingServer = { [ERROR_REPORTER]?: (error: unknown) => void }

/** Node's record of the response it is writing on a socket - its own `socketOnError` reads it. */
type ResponseSocket = Duplex & { readonly _httpMessage?: ServerResponse | null }

/** Node raises `clientError` again for every chunk that follows a parser error; one wait each. */
const closingAfterResponses = new WeakSet<Duplex>()

/**
 * Close a socket whose HTTP parser failed once every response already dispatched on it is out.
 * Node queues pipelined responses and hands the socket to the next one as each finishes, so waiting
 * on whichever holds it walks the queue in order. One that closes without finishing never hands the
 * socket on, so nothing behind it can be written either.
 *
 * A request the error cut off mid-body (a client EOF raises `HPE_INVALID_EOF_STATE`) is not waited
 * on unless its handler already ended the response: anything reading that body waits for bytes that
 * will never come, so only destroying the socket - Node's own default - fails the read.
 */
function closeAfterResponses(socket: ResponseSocket): void {
  const response = socket._httpMessage
  if (response == null || (!response.writableEnded && !response.req.complete)) {
    socket.destroy()
    return
  }
  const next = (): void => {
    response.removeListener("finish", next)
    response.removeListener("close", next)
    if (socket._httpMessage === response) socket.destroy()
    else closeAfterResponses(socket)
  }
  response.on("finish", next)
  response.on("close", next)
}

const NATIVE_MOUNTS = Symbol("nifra.node.static-mounts")

function nativeMountsOf(handler: object): readonly StaticMount[] | undefined {
  const mounts: unknown = Reflect.get(handler, NATIVE_MOUNTS)
  return Array.isArray(mounts) ? mounts : undefined
}

function staticOutcomeResponse(outcome: StaticOutcome): Response {
  if (outcome.kind === "response") return outcome.response
  const headers = new Headers()
  for (const [name, value] of Object.entries(outcome.headers ?? {})) {
    if (typeof value === "string") headers.set(name, value)
    else for (const item of value) headers.append(name, item)
  }
  const body = outcome.body === "" ? null : outcome.body
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: readStatic's bytes come from Buffer.allocUnsafe or a snapshot read, never a SharedArrayBuffer.
  return new Response(body as string | Uint8Array<ArrayBuffer> | null, {
    status: outcome.status,
    headers,
  })
}

/**
 * Serve `path` from `mounts`, starting at `from`: the first mount that takes it answers, and one that
 * falls through on a file it cannot serve hands it to the next. `undefined` when none takes it, so a
 * request no mount's prefix covers never leaves the caller's synchronous lane. `request.headers` is
 * read only once a mount takes the path: on Node's request it builds the header object.
 */
function serveMounts(
  mounts: readonly StaticMount[],
  from: number,
  path: string,
  host: () => string,
  method: "GET" | "HEAD",
  request: { readonly headers: IncomingHttpHeaders },
): Promise<StaticOutcome | undefined> | undefined {
  for (let i = from; i < mounts.length; i++) {
    const mount = mounts[i]
    if (mount === undefined) break
    const matched = matchStatic(mount, path, host)
    if (matched === "pass") continue
    // matchStatic passes what a falling-through mount refuses, so a status here is always answered.
    if ("status" in matched) {
      return Promise.resolve({ kind: "response", response: refusalOf(matched.status) })
    }
    return readStatic(mount, matched.rel, matched.immutable, method, request.headers).then(
      (outcome) => outcome ?? serveMounts(mounts, i + 1, path, host, method, request),
    )
  }
  return undefined
}

/**
 * The `static` handler for files on disk: each mount serves a directory under a URL prefix, and the
 * first mount whose prefix (and `files`, when set) takes a GET or HEAD path answers it. Passed to
 * {@link serve}, the mounts run on Node's own request, so a request none of them takes reaches the
 * app on its direct lane. Called with a Web `Request`, it answers the same way. Bun's
 * `@nifrajs/core/serve-static` and `@nifrajs/deno` take the same mounts.
 *
 * @example
 * ```ts
 * await serve(app, { port: 3000, static: serveStatic({ dir: new URL("./assets/", import.meta.url) }) })
 * ```
 */
export function serveStatic(
  mounts: ServeStaticOptions | readonly ServeStaticOptions[],
): (request: Request) => Promise<Response | undefined> | undefined {
  const states = staticMountsOf(mounts, rootOf)
  const handler = (request: Request): Promise<Response | undefined> | undefined => {
    const method = request.method
    if (method !== "GET" && method !== "HEAD") return undefined
    const url = new URL(request.url)
    const headers: IncomingHttpHeaders = {}
    for (const [name, value] of request.headers) headers[name] = value
    // A Web request names its host in its URL; a Host header may be absent.
    return serveMounts(states, 0, url.pathname, () => url.host, method, { headers })?.then(
      (outcome) => (outcome === undefined ? undefined : staticOutcomeResponse(outcome)),
    )
  }
  Object.defineProperty(handler, NATIVE_MOUNTS, { value: states })
  return handler
}

export function serve(app: FetchHandler, options: ServeOptions): Promise<NodeServer> {
  if ("signals" in options) {
    throw new TypeError(
      "[nifra/node] `signals` is now `gracefulSignals`, as on Bun's server options",
    )
  }
  activateAsyncContextFrame()
  enableNodeDirect(app)
  const report = errorReporterOf(app)
  if (options.fastResponse === true) installFastResponse()
  let inFlight = 0
  let closed = false
  // Upgrade sockets an HTTP route answers instead: Node's server no longer tracks them, so stop()
  // drains and closes them itself.
  const answering = new Set<Duplex>()
  // Upgraded WebSockets: Node's server stops tracking a socket once `ws` takes it over.
  const upgraded = new Set<WsSocket>()
  const adopt = (ws: WsSocket): boolean => {
    if (closed) return false
    upgraded.add(ws)
    ws.on("close", () => upgraded.delete(ws))
    return true
  }
  const protocol = protocolResolver(
    options.protocol ?? (options.tls === undefined ? undefined : "https"),
  )
  const hostPolicy = hostPolicyOf(options)
  const staticOption: unknown = options.static
  if (staticOption !== undefined && typeof staticOption !== "function") {
    throw new TypeError(
      "[nifra/node] `static` takes a function; pass a directory as `static: serveStatic({ dir })`",
    )
  }
  const staticState = staticOption === undefined ? undefined : nativeMountsOf(staticOption)
  const staticHandler = staticState === undefined ? options.static : undefined
  const settled = (): void => {
    inFlight -= 1
  }
  const onRequest = (nodeReq: IncomingMessage, nodeRes: ServerResponse): void => {
    inFlight += 1
    try {
      const handled = handle(
        app,
        nodeReq,
        nodeRes,
        protocol,
        staticState,
        hostPolicy,
        staticHandler,
      )
      if (handled instanceof Promise) {
        // The rejection arm is required: Node terminates the process on an unhandled rejection by
        // default. Every writer already ends and reports its own failures (`failAndReport`), so
        // anything arriving here is a fault no response can still be built from - the connection is
        // the only thing left to end. One `then`, not `catch` + `finally`: every async response
        // pays for each extra promise and microtask.
        handled.then(settled, (error: unknown) => {
          inFlight -= 1
          failAndReport(nodeRes, error)
        })
        return
      }
      inFlight -= 1
    } catch (error) {
      failAndReport(nodeRes, error)
      inFlight -= 1
    }
  }
  const resolveWs = app.resolveWebSocketUpgrade?.bind(app)
  // Only a WebSocket handshake leaves the HTTP parser; any other `Upgrade` (curl's h2c offer) is an
  // ordinary request. Node versions without the option send every upgrade to the `upgrade` event.
  // A field sent twice is joined with ", ", as Fetch's `Headers` hands it to an app on Bun, Deno and
  // Workers. Node otherwise keeps only the first of a field it treats as a singleton (Content-Type,
  // Authorization, User-Agent), so the same request was JSON here and an unsupported type there.
  const serverOptions =
    resolveWs === undefined
      ? { joinDuplicateHeaders: true }
      : { joinDuplicateHeaders: true, shouldUpgradeCallback: isWebSocketUpgrade }
  const server =
    options.tls === undefined
      ? createServer(serverOptions, onRequest)
      : createHttpsServer({ ...options.tls, ...serverOptions }, onRequest)
  if (report !== undefined) (server as ReportingServer)[ERROR_REPORTER] = report

  // Node otherwise destroys a socket as soon as its HTTP parser emits `clientError`. That can
  // discard the response for an already-dispatched request when an understated Content-Length
  // leaves surplus bytes that look like a malformed pipelined request.
  server.on("clientError", (_error, socket: ResponseSocket) => {
    if (socket.destroyed) return
    if (socket._httpMessage != null) {
      if (!closingAfterResponses.has(socket)) {
        closingAfterResponses.add(socket)
        closeAfterResponses(socket)
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
  if (resolveWs !== undefined) {
    // One `ws` server per payload cap: its `maxPayload` bounds buffering before a frame is delivered,
    // and mounted children can declare different caps.
    const servers = new Map<number | undefined, Promise<WsServer | undefined>>()
    server.on("upgrade", (nodeReq, socket, head) => {
      void handleUpgrade(
        app,
        answering,
        adopt,
        resolveWs,
        protocol,
        hostPolicy,
        nodeReq,
        socket,
        head,
        (maxPayloadBytes) => {
          let wss = servers.get(maxPayloadBytes)
          if (wss === undefined) {
            wss = loadWsServer(maxPayloadBytes)
            servers.set(maxPayloadBytes, wss)
          }
          return wss
        },
      )
    })
  }

  // Opt-in: own SIGTERM/SIGINT so `docker stop` / Ctrl-C drains in-flight requests
  // before exit. `stop` is hoisted, so `onSignal` can reference it.
  const signals = options.gracefulSignals === true ? {} : options.gracefulSignals || undefined
  const onSignal = (): void => {
    void stop(signals)
  }

  const lifecycle = lifecycleOf(app)
  async function stop({
    drainMs = DEFAULT_DRAIN_MS,
    delayMs = 0,
  }: NodeStopOptions = {}): Promise<void> {
    if (closed) return // idempotent
    closed = true
    if (signals !== undefined) {
      // Remove our own handlers so repeated serve()/stop() cycles don't leak listeners.
      process.removeListener("SIGTERM", onSignal)
      process.removeListener("SIGINT", onSignal)
    }
    await lifecycle("stopping")
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
    server.close() // stop accepting new connections; existing requests continue
    // A WebSocket gets a close handshake now and the drain window to finish it.
    for (const ws of upgraded) ws.close(1001, "server shutting down")
    const deadline = Date.now() + drainMs
    while ((inFlight > 0 || answering.size > 0 || upgraded.size > 0) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, DRAIN_POLL_MS))
    }
    server.closeAllConnections() // force-close stragglers + idle keep-alive sockets
    for (const socket of answering) socket.destroy()
    for (const ws of upgraded) ws.terminate()
    await lifecycle("stopped")
  }

  return new Promise((resolve) => {
    // Do not pass an explicit `undefined` hostname. Node accepts it, but Bun's Node-compatible
    // `http.Server.listen` can misinterpret that overload (especially with port 0) as a failed bind.
    // Omitting the argument selects the same default host while keeping the overload unambiguous.
    const onListening = (): void => {
      const address = server.address()
      const port = address !== null && typeof address === "object" ? address.port : options.port
      if (signals !== undefined) {
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
            (error: unknown) => failAndReport(nodeRes, error),
          )
        : writeOutcomeSafely(outcome, nodeRes, nodeReq.method)
    } catch (error) {
      failAndReport(nodeRes, error)
      return
    }
  }

  return runWebRequest(
    app,
    toWebRequest(nodeReq, protocol, host, nodeRes),
    nodeReq,
    nodeRes,
    platform,
  )
}

/**
 * Resolve the target's `.` / `..` segments and backslashes, and encode what a parser encodes in a
 * path, in place, before anything reads it. Node keeps the target as the client sent it, where Bun
 * and workerd deliver it parsed; resolving it here routes `/users/../admin` to `/admin` and
 * `/vault<tag>` to `/vault%3Ctag%3E` on every runtime, and every later reader - static files,
 * mounts, the app, `c.req.url` - sees the one path.
 */
const ABSOLUTE_FORM = /^[a-z][a-z\d+.-]*:\/\//i

function resolveTarget(nodeReq: IncomingMessage): void {
  let target = nodeReq.url
  if (target === undefined) return
  // Absolute-form (`GET http://host/path`, RFC 9112 section 3.2.2) is routed as its origin-form path
  // with the Host header, as Bun does. Kept whole, hooks saw `http://hosthttp://...` while the
  // router matched the full URL against a `/*` route.
  if (target.charCodeAt(0) !== 47 && ABSOLUTE_FORM.test(target)) {
    let end = target.indexOf("//") + 2
    while (end < target.length && target[end] !== "/" && target[end] !== "?") end++
    const rest = target.slice(end)
    target = rest.charCodeAt(0) === 47 ? rest : `/${rest}`
    nodeReq.url = target
  }
  if (needsResolving(target)) nodeReq.url = resolveDotSegments(target)
}

function handle(
  app: FetchHandler,
  nodeReq: IncomingMessage,
  nodeRes: ServerResponse,
  getProtocol: RequestProtocolResolver,
  staticState: readonly StaticMount[] | undefined,
  hostPolicy: HostPolicy,
  staticHandler?: (request: Request) => Response | Promise<Response | undefined> | undefined,
): void | Promise<void> {
  resolveTarget(nodeReq)
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

  // A `static` function other than serveStatic's mounts takes a Web request, so the app gets the same
  // one rather than its direct lane.
  if (staticHandler !== undefined) {
    const request = toWebRequest(nodeReq, protocol, host, nodeRes)
    let answer: Response | Promise<Response | undefined> | undefined
    try {
      answer = staticHandler(request)
    } catch {
      writeInternalError(nodeRes)
      return
    }
    if (answer === undefined) return runWebRequest(app, request, nodeReq, nodeRes, platform)
    if (!(answer instanceof Promise)) return writeResponseSafely(answer, nodeRes, nodeReq.method)
    return answer.then(
      (response) =>
        response === undefined
          ? runWebRequest(app, request, nodeReq, nodeRes, platform)
          : writeResponseSafely(response, nodeRes, nodeReq.method),
      () => writeInternalError(nodeRes),
    )
  }

  // Static files first (GET/HEAD). The match is synchronous, so a non-asset request never leaves the
  // app's sync fast path below; only a prefix hit reads from disk (and async-writes the file).
  const method = nodeReq.method
  if (staticState !== undefined && (method === "GET" || method === "HEAD")) {
    let served: Promise<StaticOutcome | undefined> | undefined
    try {
      served = serveMounts(
        staticState,
        0,
        staticPathOf(nodeReq.url ?? "/"),
        // The host the app sees, as the Web lane's URL carries it.
        () => host,
        method,
        nodeReq,
      )
    } catch {
      writeInternalError(nodeRes)
      return
    }
    if (served !== undefined) {
      return served.then(
        (outcome) =>
          outcome === undefined
            ? toApp(app, nodeReq, nodeRes, protocol, host, platform)
            : writeOutcomeSafely(outcome, nodeRes, method),
        () => failWrite(nodeRes),
      )
    }
  }
  return toApp(app, nodeReq, nodeRes, protocol, host, platform)
}

/** The app's answer for a request no static mount took. */
function toApp(
  app: FetchHandler,
  nodeReq: IncomingMessage,
  nodeRes: ServerResponse,
  protocol: RequestProtocol,
  host: string,
  platform: NodePlatform | undefined,
): void | Promise<void> {
  // A mounted handler may advertise a native Node lane. Core has already checked route precedence
  // and every global lifecycle gate before returning this selection. The handler writes directly to
  // `nodeRes`; `false` means its optional transport was unavailable, so the same untouched source
  // continues through the ordinary Web/direct path below.
  const resolveNodeSource = (app as Partial<NodeFastHandler>).resolveNodeSource
  const appProperties: unknown = app
  const resolveNodeMount = (appProperties as Record<symbol, unknown>)[RESOLVE_NODE_MOUNT]
  if (typeof resolveNodeSource === "function" || typeof resolveNodeMount === "function") {
    const nodeSource = toNodeRequestSource(nodeReq, protocol, host, nodeRes)

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
              (error: unknown) => failAndReport(nodeRes, error),
            )
          }
          if (outcome !== false) return
        } catch (error) {
          failAndReport(nodeRes, error)
          return
        }
      }
    }

    return runNodeSource(app, nodeSource, nodeReq, nodeRes, protocol, host, platform)
  }

  return runWebRequest(
    app,
    toWebRequest(nodeReq, protocol, host, nodeRes),
    nodeReq,
    nodeRes,
    platform,
  )
}

/** Answer through a Web `Request`: the app's `resolveNode` lane when it has one, else `fetch`. */
function runWebRequest(
  app: FetchHandler,
  request: Request,
  nodeReq: IncomingMessage,
  nodeRes: ServerResponse,
  platform: NodePlatform | undefined,
): void | Promise<void> {
  const resolveNode = (app as Partial<NodeFastHandler>).resolveNode
  if (typeof resolveNode === "function") {
    try {
      const outcome = resolveNode.call(app, request, platform)
      return outcome instanceof Promise
        ? outcome.then(
            (settled) => writeOutcomeSafely(settled, nodeRes, nodeReq.method),
            (error: unknown) => failAndReport(nodeRes, error),
          )
        : writeOutcomeSafely(outcome, nodeRes, nodeReq.method)
    } catch (error) {
      failAndReport(nodeRes, error)
      return
    }
  }

  try {
    const response = app.fetch(request, platform)
    return response instanceof Promise
      ? response.then(
          (settled) => writeResponseSafely(settled, nodeRes, nodeReq.method),
          (error: unknown) => failAndReport(nodeRes, error),
        )
      : writeResponseSafely(response, nodeRes, nodeReq.method)
  } catch (error) {
    // A request hook that throws escapes `fetch`; never leak a stack to the wire.
    failAndReport(nodeRes, error)
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
      // The failed write may have staged the response's own headers (cookies among them) with
      // `setHeaders`; the 500 must not carry them.
      for (const name of nodeRes.getHeaderNames()) nodeRes.removeHeader(name)
      writeInternalError(nodeRes)
      return
    }
  } catch {
    // The socket went away between the check and the write; fall through to the destroy.
  }
  nodeRes.destroy()
}

/** {@link failWrite} for a failure the app never answered, logged through the app's own logger. */
function failAndReport(nodeRes: ServerResponse, error: unknown): void {
  const socket = nodeRes.req?.socket as { readonly server?: ReportingServer } | null | undefined
  const report = socket?.server?.[ERROR_REPORTER]
  try {
    report?.(error)
  } catch {
    // A logger that throws must not keep the 500 from going out.
  }
  failWrite(nodeRes)
}

/** {@link writeNodeOutcome} with {@link failAndReport} behind it, sync throw and async rejection
 * alike. */
function writeOutcomeSafely(
  outcome: NodeServeOutcome,
  nodeRes: ServerResponse,
  method?: string,
): void | Promise<void> {
  try {
    const written = writeNodeOutcome(outcome, nodeRes, method)
    return written instanceof Promise
      ? written.catch((error: unknown) => failAndReport(nodeRes, error))
      : written
  } catch (error) {
    failAndReport(nodeRes, error)
    return
  }
}

/** {@link writeNodeResponse} with {@link failAndReport} behind it - same contract as
 * {@link writeOutcomeSafely}, for the lanes that carry a `Response`. */
function writeResponseSafely(
  response: Response,
  nodeRes: ServerResponse,
  method?: string,
): void | Promise<void> {
  try {
    const written = writeNodeResponse(response, nodeRes, method)
    return written instanceof Promise
      ? written.catch((error: unknown) => failAndReport(nodeRes, error))
      : written
  } catch (error) {
    failAndReport(nodeRes, error)
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
 * Store one wire header on a literal record. A literal `__proto__` name must not go through plain
 * assignment - the inherited setter would silently swallow it - so it is defined as an own data
 * property instead; every other name takes the fast plain store. Same guard core's portable header
 * view makes over the same record, so a hook-set `__proto__` header round-trips to the wire
 * exactly as it did through the old normalization copy.
 */
function storeWireHeader(
  headers: Record<string, string | string[]>,
  name: string,
  value: string | string[],
): void {
  if (name === "__proto__") {
    Object.defineProperty(headers, name, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    })
    return
  }
  headers[name] = value
}

/** True when an existing header slot can be replaced without throwing or invoking an accessor. */
function canReplaceHeaderSlot(record: Readonly<Record<string, unknown>>, name: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(record, name)
  return descriptor === undefined || ("writable" in descriptor && descriptor.writable === true)
}

/**
 * A proven lowercase record can stay on the Node hot path when the writer only has to append its
 * own framing headers. Non-default framing names and explicit lengths take the copy path: the old
 * writer moved those names to the end of the record, and retaining that order keeps raw HTTP/1.1
 * snapshots stable. Core's default JSON type is the one exception - it appends that value before
 * this writer runs, so recognizing it lets the common hooked route retain the record and append
 * length in place. An application that explicitly supplies the same default value is indistinguishable
 * here and follows that same semantics-preserving fast path.
 */
function canWriteJsonHeadersInPlace(
  source: Readonly<Record<string, string | readonly string[]>>,
  cookies: readonly string[] | undefined,
): source is Record<string, string | string[]> {
  try {
    if (!Object.isExtensible(source)) return false
    if (Object.hasOwn(source, "content-length")) return false
    if (Object.hasOwn(source, "content-type") && source["content-type"] !== JSON_CONTENT_TYPE) {
      return false
    }
    if (
      cookies !== undefined &&
      cookies.length > 0 &&
      !canReplaceHeaderSlot(source, "set-cookie")
    ) {
      return false
    }
    return true
  } catch {
    // A proxy or a hostile descriptor should use the same isolated fallback as mixed-case input.
    return false
  }
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
  // lowercase names. Whether a name needs folding is answered either by core's mark (the native
  // response walk already looked at these keys, so re-walking them here is the same pass twice)
  // or, when the record never went through that walk, by the scan below.
  //
  // A proven lowercase, extensible record is owned by this request. Keep it in place and append
  // lowercase framing names directly; the old uppercase rename paid two deletes and demoted the
  // record to dictionary mode. Mixed-case, frozen, and explicitly framed records take an isolated
  // copy below, preserving the old source order and protecting caller-owned objects.
  const source = outcome.headers
  const lowercase =
    source === undefined ||
    (source as Record<symbol, unknown>)[LOWERCASE_HEADER_KEYS] === true ||
    allHeaderKeysLowercase(source)
  const inPlace =
    source === undefined || (lowercase && canWriteJsonHeadersInPlace(source, outcome.cookies))
  const headers: Record<string, string | string[]> =
    inPlace && source !== undefined ? (source as Record<string, string | string[]>) : {}
  let contentType: string | string[] | undefined
  let hasLength = false
  if (!inPlace && source !== undefined) {
    for (const key of Object.keys(source)) {
      const lower = lowercase ? key : key.toLowerCase()
      if (lower === "content-type") {
        contentType = source[key] as string | string[]
        continue
      }
      if (lower === "content-length") {
        hasLength = true
        continue
      }
      storeWireHeader(headers, lower, source[key] as string | string[])
    }
  }
  // A `null` body is a 204/no-content render - `new Response(null)` carries no Content-Type, so we add
  // none either; a non-null body is JSON, matching `Response.json`'s Content-Type (a hook-supplied
  // Content-Type wins). The length is known regardless of who set the type, so always declare it -
  // without it Node falls back to chunked framing, which costs extra wire bytes and client parsing
  // on every response (and no other runtime chunks a buffered JSON body).
  if (outcome.body !== null) {
    if (inPlace) {
      if (!Object.hasOwn(headers, "content-type")) headers["content-type"] = JSON_CONTENT_TYPE
      headers["content-length"] = String(Buffer.byteLength(outcome.body))
    } else {
      storeWireHeader(headers, "content-type", contentType ?? JSON_CONTENT_TYPE)
      storeWireHeader(headers, "content-length", String(Buffer.byteLength(outcome.body)))
    }
  } else if (isBodylessStatus(outcome.status)) {
    // 204/205/304 never carry a payload; a user/native-hook length is dropped rather than copied,
    // so the direct writer cannot advertise bytes that will not ship.
  } else if (!isHead && !hasLength) {
    // A body-less render at a status that MAY carry a body - a `redirect()`, above all. Node frames
    // a `writeHead` + bare `end()` as chunked, so the shortest response the framework emits went out
    // with a chunk terminator and no length, where every Web-native runtime sends `content-length: 0`.
    // Declared here so the wire matches them. HEAD is excluded: its length describes the GET's body,
    // which this lane does not know.
    headers["content-length"] = "0"
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

/** What a request's signal follows: the response it is answered on, or an upgrade's raw socket. */
interface RequestEnd {
  readonly writableFinished: boolean
  readonly closed: boolean
  once(event: "close", listener: () => void): unknown
}

function toWebRequest(
  req: IncomingMessage,
  protocol: RequestProtocol,
  host: string,
  res?: RequestEnd,
): Request {
  const url = `${protocol}://${host}${req.url ?? "/"}`
  const method = req.method ?? "GET"
  const signal = res === undefined ? undefined : disconnectSignal(res)
  return makeWebRequest(req, method, url, headerRecordFromNode(req.headers), undefined, signal)
}

function toNodeRequestSource(
  req: IncomingMessage,
  protocol: RequestProtocol,
  host: string,
  res: ServerResponse,
): NodeRequestSource {
  const method = req.method ?? "GET"
  return method === "GET" || method === "HEAD"
    ? new LeanNodeGetSource(req, method, protocol, host, res)
    : new LazyNodeRequestSource(req, method, protocol, host, res)
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
  const fragment = target.indexOf("#")
  const searchEnd = fragment === -1 ? target.length : fragment
  const question = target.indexOf("?")
  const searchStart = question !== -1 && question < searchEnd ? question : -1
  const pathEnd = searchStart === -1 ? searchEnd : searchStart
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

// Fetch's `json()` decodes UTF-8 without a leading byte order mark; `Buffer#toString` keeps one, and
// `JSON.parse` then refuses a body every other runtime parses.
const utf8Text = (body: Buffer): string =>
  body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf
    ? body.toString("utf8", 3)
    : body.toString("utf8")

function parseJsonBytes(bytes: Uint8Array): unknown {
  const buffer = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return JSON.parse(utf8Text(buffer)) as unknown
}

const bodyItself = (body: Buffer): Buffer => body

const parsedWithLength = (
  body: Buffer,
): { readonly value: unknown; readonly byteLength: number } => ({
  value: JSON.parse(utf8Text(body)) as unknown,
  byteLength: body.byteLength,
})

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

/** What both Node request sources read straight off `IncomingMessage`: URL, URL parts, headers. */
abstract class NodeSourceBase {
  readonly method: string

  protected headersValue: Headers | undefined
  protected requestValue: Request | undefined
  private urlValue: string | undefined
  protected readonly nodeReq: IncomingMessage
  private readonly protocol: RequestProtocol
  private readonly host: string
  protected readonly nodeRes: ServerResponse

  constructor(
    nodeReq: IncomingMessage,
    method: string,
    protocol: RequestProtocol,
    host: string,
    nodeRes: ServerResponse,
  ) {
    this.nodeReq = nodeReq
    this.method = method
    this.protocol = protocol
    this.host = host
    this.nodeRes = nodeRes
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

  // Read straight off Node's request (comma-joining multi-values to match `Headers.get`) so the
  // body-cap path can check content-type/length without building a `Headers`.
  header(name: string): string | null {
    return nodeRequestHeader(this.nodeReq, name)
  }
}

/**
 * Lazy view over a Node `IncomingMessage`. Methods live on the prototype (not re-allocated per
 * request), and every materialization is deferred: the `Headers` object, the Web `ReadableStream`
 * body, and the undici `Request` are each built only when first read. Body-capable methods use this
 * source; GET/HEAD use the smaller {@link LeanNodeGetSource}.
 */
class LazyNodeRequestSource extends NodeSourceBase implements NodeRequestSource {
  private bodyValue: ReadableStream<Uint8Array> | null | undefined
  private consumedBody: Buffer | undefined
  private bodyRead: BodyReadState | undefined
  private readBodyPromise: Promise<Buffer> | undefined
  private mappedRead: Promise<unknown> | undefined
  private rawReaders: NodeRawBodyReaders | undefined

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
    return this.readNodeBody().then((buffer) => JSON.parse(utf8Text(buffer)) as unknown)
  }

  jsonWithByteLength(): Promise<{ readonly value: unknown; readonly byteLength: number }> {
    if (this.requestValue !== undefined) {
      return this.requestValue.arrayBuffer().then((buffer) => ({
        value: JSON.parse(utf8Text(Buffer.from(buffer))) as unknown,
        byteLength: buffer.byteLength,
      }))
    }
    // The first read parses as the body settles: one promise from socket to value, not two.
    if (
      this.consumedBody === undefined &&
      this.readBodyPromise === undefined &&
      this.mappedRead === undefined
    ) {
      return this.collectBody(parsedWithLength)
    }
    return this.readNodeBody().then(parsedWithLength)
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
    const handed = this.handedBody()
    if (handed != null) {
      return new Response(handed).arrayBuffer().then((buffer) => new Uint8Array(buffer))
    }
    return this.readNodeBody()
  }

  /**
   * The stream the Web `Request` was built on, or - once a hook's `req.clone()` teed it (which locks
   * the original) - the branch that request kept. Reading the locked original threw, so a middleware
   * that peeked at the body through a clone turned every downstream body read into a 500.
   */
  private handedBody(): ReadableStream<Uint8Array> | undefined {
    const handed = this.bodyValue
    if (handed == null || !handed.locked) return handed ?? undefined
    const owner = this.requestValue as { readonly _real?: Request } | undefined
    return owner?._real?.body ?? handed
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
    return this.handedBody() ?? this.bodyValue
  }

  get request(): Request {
    this.requestValue ??= new LazyWebRequest(
      this.method,
      this.url,
      () => this.headersValue ?? headerRecordFromNode(this.nodeReq.headers),
      (headers, signal) => {
        if (this.consumedBody !== undefined) {
          const real = makeWebRequest(
            this.nodeReq,
            this.method,
            this.url,
            headers,
            this.consumedBody,
            signal,
          )
          // Preserve one-shot body semantics if user code asks for `c.req` after nifra already
          // consumed it.
          void real.arrayBuffer().catch(() => {})
          return real
        }
        const handed = this.bodyValue
        if (handed != null) {
          const locked = handed.locked
          const webStream: unknown = handed
          // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: isDisturbed reads any Web stream at runtime; only the DOM and node:stream/web typings fail to overlap
          const disturbed = Readable.isDisturbed(webStream as NodeWebReadableStream)
          // undici refuses a body stream that was already read or locked, which `body` has handed
          // out before any member forced this request. Seed it with a stand-in in the same state so
          // `bodyUsed`, `signal`, and the rest answer as they would on a native request.
          if (locked || disturbed) {
            const real = makeWebRequest(
              this.nodeReq,
              this.method,
              this.url,
              headers,
              new ReadableStream<Uint8Array>(),
              signal,
            )
            const standIn = real.body
            if (disturbed) void standIn?.cancel()
            if (locked) standIn?.getReader()
            return real
          }
        }
        return makeWebRequest(this.nodeReq, this.method, this.url, headers, this.body, signal)
      },
      this.nodeRes,
    )
    return this.requestValue
  }

  // Buffer the request body once. A single-chunk body (the common case) skips the array + `concat`;
  // a client abort / socket error rejects (via `error`/`close`), which the body-cap callers catch
  // and map to a flat 400.
  private readNodeBody(): Promise<Buffer> {
    if (this.consumedBody !== undefined) return Promise.resolve(this.consumedBody)
    if (this.readBodyPromise === undefined) {
      const mapped = this.mappedRead
      if (mapped === undefined) {
        this.readBodyPromise = this.collectBody(bodyItself)
      } else {
        // A raw reader arriving mid-read waits on that read: listening now would miss earlier
        // chunks. A failed parse still consumed the body, so either outcome yields the bytes.
        const bytesOf = (reason?: unknown): Buffer => {
          if (this.consumedBody !== undefined) return this.consumedBody
          throw reason
        }
        this.readBodyPromise = mapped.then(bytesOf, bytesOf)
      }
    }
    return this.readBodyPromise
  }

  /** Listen for the body once and settle with `map` of its bytes, which later readers share. */
  private collectBody<T>(map: (body: Buffer) => T): Promise<T> {
    if (this.nodeReq.destroyed)
      return Promise.reject(new Error("request closed before body completed"))
    const read = new NodeBodyRead(map, this.onBodyDone.bind(this))
    this.bodyRead = read
    this.nodeReq.on("data", read.onData)
    this.nodeReq.on("end", read.onDone)
    this.nodeReq.on("error", read.onDone)
    this.nodeReq.on("close", read.onDone)
    if (map !== bodyItself) this.mappedRead = read.result
    return read.result
  }

  private onBodyDone(error?: unknown): void {
    const read = this.bodyRead
    if (read === undefined) return
    this.bodyRead = undefined
    this.nodeReq.removeListener("data", read.onData)
    this.nodeReq.removeListener("end", read.onDone)
    this.nodeReq.removeListener("error", read.onDone)
    this.nodeReq.removeListener("close", read.onDone)
    if (error !== undefined) read.fail(error)
    else if (!this.nodeReq.readableEnded)
      read.fail(new Error("request closed before body completed"))
    else {
      const body = read.bytes()
      this.consumedBody = body
      read.finish(body)
    }
  }
}

/**
 * GET/HEAD requests dominate API reads and never carry a body. This source keeps that path lean while
 * preserving the full Web `Request` escape hatch if user code reads `c.req`/`c.request`.
 */
class LeanNodeGetSource extends NodeSourceBase implements NodeRequestSource {
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
      (headers, signal) =>
        makeWebRequest(this.nodeReq, this.method, this.url, headers, null, signal),
      this.nodeRes,
    )
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
function headerRecordFromNode(input: IncomingHttpHeaders): NodeHeaderInit {
  const record = Object.create(null) as Record<string, string>
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue
    const joined = Array.isArray(value) ? value.join(", ") : value
    // Node trims every field line, so a trailing space means the last member was empty.
    if (joined.endsWith(" ")) return headerPairsFromNode(input)
    record[key] = joined
  }
  return record
}

type NodeHeaderInit = Record<string, string> | Array<[string, string]>

/**
 * The same bag as `[name, value]` pairs, for a request whose joined value ends in an empty member.
 * `Headers` strips the whitespace around each value it is given, so the record's `"a, "` would read
 * back as `"a,"`; appending the empty members one by one keeps the `"a, "` Bun and Deno show.
 */
function headerPairsFromNode(input: IncomingHttpHeaders): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const member of value) pairs.push([key, member])
      continue
    }
    const delimiter = key === "cookie" ? "; " : ", "
    let base = value
    let empty = 0
    while (base.endsWith(delimiter)) {
      base = base.slice(0, -delimiter.length)
      empty++
    }
    pairs.push([key, base])
    for (; empty > 0; empty--) pairs.push([key, ""])
  }
  return pairs
}

/** A request's `signal`: it aborts when the client goes away before the response finished, as on Bun
 * and Deno. */
function disconnectSignal(res: RequestEnd): AbortSignal {
  const disconnect = new AbortController()
  const onClose = (): void => {
    if (!res.writableFinished) disconnect.abort()
  }
  if (res.closed) onClose()
  else res.once("close", onClose)
  return disconnect.signal
}

function makeWebRequest(
  req: IncomingMessage,
  method: string,
  url: string,
  headers: Headers | NodeHeaderInit,
  body?: ReadableStream<Uint8Array> | Uint8Array | null,
  signal?: AbortSignal,
): Request {
  const init: RequestInit & { duplex?: "half" } = { method, headers }
  if (signal !== undefined) init.signal = signal
  if (method !== "GET" && method !== "HEAD") {
    // Stream the body in; `duplex: "half"` is required for a streamed request body.
    init.body =
      body instanceof Uint8Array ? body.slice() : (body ?? claimableWebStream(req, "drain"))
    init.duplex = "half"
  }
  return new Request(url, init)
}

/**
 * A LAZY Web `Request` over a Node request. Constructing an undici `Request` costs ~2μs per call -
 * its internal URL parse alone showed at ~2.4% of a realistic request - yet most consumers of
 * `c.req` (and of the `req` argument Web hooks receive) only ever read `method`, `url`, or a
 * header. This class serves those three from what the adapter already has, materializes one real
 * `Headers` on first `headers` access, builds `signal` from the response's close, and defers the full
 * undici `Request` until something needs the rest of the surface (body readers, `clone`, ...),
 * forwarding to it from then on. The prototype chains to the native `Request`, so `instanceof Request` holds and
 * every forwarded member runs with a genuine receiver. The `url` is ALWAYS the adapter's own
 * derivation (the declared protocol trust) - never re-derived here.
 */
const LazyWebRequest = /* @__PURE__ */ (() => {
  const NativeRequest = globalThis.Request
  class LazyWebRequest implements Request {
    // `forwardToReal` installs these descriptors at runtime; declarations make that contract
    // visible to TypeScript without emitting class fields.
    declare readonly body: Request["body"]
    declare readonly bodyUsed: Request["bodyUsed"]
    declare readonly duplex: Request extends { readonly duplex: infer Duplex } ? Duplex : never
    declare readonly textStream: Request["textStream"]
    declare arrayBuffer: Request["arrayBuffer"]
    declare blob: Request["blob"]
    declare bytes: Request["bytes"]
    declare formData: Request["formData"]
    declare json: Request["json"]
    declare text: Request["text"]
    declare readonly cache: Request["cache"]
    declare readonly credentials: Request["credentials"]
    declare readonly destination: Request["destination"]
    declare readonly integrity: Request["integrity"]
    declare readonly keepalive: Request["keepalive"]
    declare readonly mode: Request["mode"]
    declare readonly redirect: Request["redirect"]
    declare readonly referrer: Request["referrer"]
    declare readonly referrerPolicy: Request["referrerPolicy"]
    declare clone: Request["clone"]
    #method: string
    #url: string
    #headersInit: (() => Headers | NodeHeaderInit) | undefined
    #materialize: ((headers: Headers | NodeHeaderInit, signal: AbortSignal) => Request) | undefined
    #end: RequestEnd
    #headers: Headers | undefined
    #signal: AbortSignal | undefined
    #real: Request | undefined

    constructor(
      method: string,
      url: string,
      headersInit: () => Headers | NodeHeaderInit,
      materialize: (headers: Headers | NodeHeaderInit, signal: AbortSignal) => Request,
      end: RequestEnd,
    ) {
      this.#method = method
      this.#url = url
      this.#headersInit = headersInit
      this.#materialize = materialize
      this.#end = end
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
      const init = (this.#headersInit as () => Headers | NodeHeaderInit)()
      this.#headers = init instanceof Headers ? init : new Headers(init)
      return this.#headers
    }

    // A page render reads it for every document, so it must not build the real request. That one,
    // once built, follows this signal, and reading it keeps returning this one.
    get signal(): AbortSignal {
      this.#signal ??= disconnectSignal(this.#end)
      return this.#signal
    }

    /** The real undici Request, built on first demand. Named for the forwarding descriptors below. */
    get _real(): Request {
      if (this.#real === undefined) {
        const materialize = this.#materialize as (
          h: Headers | NodeHeaderInit,
          signal: AbortSignal,
        ) => Request
        // Hand the materializer the SAME Headers a hook may already have observed (and mutated),
        // so the real request reflects it; otherwise let it build from its own cheap record.
        this.#real = materialize(
          this.#headers ?? (this.#headersInit as () => Headers | NodeHeaderInit)(),
          this.signal,
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
  const own = new Set<string | symbol>(["constructor", "method", "url", "headers", "signal"])
  forwardToReal(LazyWebRequest.prototype, NativeRequest.prototype, own)
  Object.setPrototypeOf(LazyWebRequest.prototype, NativeRequest.prototype)
  return LazyWebRequest
})()

/** Forward each method and accessor of `native` that `own` does not name to the instance's `_real`. */
function forwardToReal(prototype: object, native: object, own: ReadonlySet<string | symbol>): void {
  for (const key of [
    ...Object.getOwnPropertyNames(native),
    ...Object.getOwnPropertySymbols(native),
  ]) {
    if (own.has(key)) continue
    const descriptor = Object.getOwnPropertyDescriptor(native, key)
    if (descriptor === undefined) continue
    if (typeof descriptor.value === "function") {
      Object.defineProperty(prototype, key, {
        configurable: true,
        writable: true,
        value: function (this: { readonly _real: unknown }, ...args: unknown[]) {
          const real = this._real as Record<string | symbol, unknown>
          return (real[key] as (...a: unknown[]) => unknown).apply(real, args)
        },
      })
    } else if (descriptor.get !== undefined) {
      Object.defineProperty(prototype, key, {
        configurable: true,
        get(this: { readonly _real: unknown }) {
          return (this._real as Record<string | symbol, unknown>)[key]
        },
      })
    }
  }
}

/** A writable end whose backpressure can be awaited: a response, or an upgrade socket answered as one. */
interface DrainTarget {
  readonly destroyed: boolean
  readonly writableEnded: boolean
  readonly writable: boolean
  once(event: "drain" | "close" | "error", listener: () => void): unknown
  removeListener(event: "drain" | "close" | "error", listener: () => void): unknown
}

function waitForDrain(nodeRes: DrainTarget): Promise<boolean> {
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
  // A body already sent once answered another request, with headers written for that one.
  if (response.bodyUsed) throw new TypeError("[nifra] a Response body can be sent only once")
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
    // Nothing reads a HEAD answer's body. Cancelled, its source learns the exchange is over, as on
    // Bun and Deno; left alone, a streaming route's producer runs on with no reader.
    response.body?.cancel().catch(() => {})
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
  // A client that leaves while the stream is idle never fails a write. Its departure cancels the
  // stream, as on Bun and Deno, so a producer waiting to send learns the exchange is over.
  const onClose = (): void => {
    reader.cancel().catch(() => {})
  }
  nodeRes.once("close", onClose)
  if (nodeRes.destroyed) onClose()
  try {
    await writeNodeResponseChunks(reader, response, nodeRes, canDeclareLength)
  } finally {
    nodeRes.removeListener("close", onClose)
  }
}

async function writeNodeResponseChunks(
  reader: BodyReader,
  response: Response,
  nodeRes: ServerResponse,
  canDeclareLength: boolean,
): Promise<void> {
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
    // `ws` reads `maxPayload: 0` as no limit, so a cap of 0 buffers at most a byte and the message
    // check in `attachNodeWebSocket` refuses anything but an empty frame.
    return Ctor === undefined
      ? undefined
      : new Ctor(
          maxPayloadBytes === undefined
            ? { noServer: true }
            : { noServer: true, maxPayload: Math.max(maxPayloadBytes, 1) },
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
  app: FetchHandler,
  answering: Set<Duplex>,
  adopt: (ws: WsSocket) => boolean,
  resolveWs: (
    request: Request,
    platform?: NodePlatform,
  ) => WsUpgradeOutcome | Promise<WsUpgradeOutcome>,
  getProtocol: RequestProtocolResolver,
  hostPolicy: HostPolicy,
  nodeReq: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  getWss: (maxPayloadBytes?: number) => Promise<WsServer | undefined>,
): Promise<void> {
  // A peer can reset the socket while the guard is awaited; with no listener that error ends the process.
  socket.on("error", ignoreSocketError)
  resolveTarget(nodeReq)
  let outcome: WsUpgradeOutcome
  let request: Request
  let platform: NodePlatform | undefined
  try {
    const host = requestHost(nodeReq, hostPolicy)
    if (host === undefined) {
      writeUpgradeRejection(socket, 400, "bad_request")
      return
    }
    const peerAddress = nodeReq.socket.remoteAddress
    platform = peerAddress === undefined ? undefined : { clientIp: peerAddress }
    // Its signal follows the socket, so a route answered below stops when the client leaves.
    request = toWebRequest(nodeReq, getProtocol(nodeReq), host, socket)
    outcome = await resolveWs(request, platform)
  } catch {
    writeUpgradeRejection(socket, 500, "internal_error")
    return
  }
  if (outcome.kind === "pass") {
    // No WS route here: the HTTP route answers, as on Bun. Only a bodiless request can be served from
    // an upgrade socket - Node parses no body for one, so a POST here (Node without
    // `shouldUpgradeCallback`) keeps the 404.
    if (nodeReq.method !== "GET" && nodeReq.method !== "HEAD") {
      writeUpgradeRejection(socket, 404, "not_found")
      return
    }
    let response: Response
    try {
      response = await app.fetch(request, platform)
    } catch {
      writeUpgradeRejection(socket, 500, "internal_error")
      return
    }
    answering.add(socket)
    socket.once("close", () => answering.delete(socket))
    // Detached from Node's HTTP handling, the socket comes paused and nothing ends it on the client's
    // FIN. Reading it and ending on `end`, as Node's server does, lets a departure reach the signal.
    socket.once("end", () => socket.end())
    socket.resume()
    await writeSocketResponse(socket, response, nodeReq.method)
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
  const upgrade = outcome
  wss.handleUpgrade(nodeReq, socket, head, (ws) => {
    // An upgrade still resolving when stop() ran must not outlive it.
    if (!adopt(ws)) {
      ws.terminate()
      return
    }
    attachNodeWebSocket(ws, upgrade)
  })
}

/** Wire a `ws` socket (already open in `handleUpgrade`'s callback) to a nifra WS handler. The Node copy
 * of core's `attachWebSocket` - binary frames normalize to `Uint8Array`; a thrown/rejected callback
 * routes to `error()` and never crashes the connection. */
function attachNodeWebSocket(
  ws: WsSocket,
  outcome: Extract<WsUpgradeOutcome, { readonly kind: "upgrade" }>,
): void {
  const { handler, data, pubsub, maxPayloadBytes } = outcome
  const rawSend = (payload: string | ArrayBufferView | ArrayBuffer): void => {
    if (typeof payload !== "string" || !writeTextFrame(ws, payload)) ws.send(payload)
  }
  // `ws` reports the peer's echo, without its reason, and 1006 after failing a message over its own
  // `maxPayload`; `close` is given the server's own close when the server closed first, as on Bun.
  let sentClose: readonly [number, string] | undefined
  // A close with no code is 1000 here as on Bun, whose close() cannot send one without a status.
  const closeSocket = (code = 1000, reason?: string): void => {
    if (sentClose === undefined && ws.readyState <= 1) sentClose = [code, reason ?? ""]
    ws.close(code, reason)
  }
  const nifra: NifraWs = {
    send: outcome.sender === undefined ? rawSend : outcome.sender(handler, rawSend, reportError),
    close: (code, reason) => {
      assertCloseArgs(code, reason)
      closeSocket(code, reason)
    },
    get readyState() {
      return ws.readyState
    },
    subscribe: (topic) => pubsub.subscribe(topic, nifra),
    unsubscribe: (topic) => pubsub.unsubscribe(topic, nifra),
    data,
    raw: ws,
  }
  function reportError(error: unknown): void {
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
    if (maxPayloadBytes !== undefined && raw.byteLength > maxPayloadBytes) {
      closeSocket(1009, "message too large")
      return
    }
    const payload: NifraWsData = isBinary
      ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
      : raw.toString()
    safe(() => handler.message?.(nifra, payload))
  })
  ws.on("close", (code, reason) => {
    pubsub.unsubscribeAll(nifra) // drop topic subscriptions so the registry never holds a dead socket
    const [sentCode, sentReason] = sentClose ?? [code, reason.toString()]
    safe(() => handler.close?.(nifra, sentCode, sentReason))
  })
  ws.on("error", (error) => {
    if ("code" in error && error.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH")
      sentClose ??= [1009, "message too large"]
    reportError(error)
  })
  safe(() => handler.open?.(nifra)) // open: the socket is already established here
}

function ignoreSocketError(): void {}

function isWebSocketUpgrade(nodeReq: IncomingMessage): boolean {
  // A handshake is a GET (RFC 6455 section 4.1); any other method is an ordinary request with a body.
  return nodeReq.method === "GET" && /\bwebsocket\b/i.test(nodeReq.headers.upgrade ?? "")
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

/** Answer an upgrade socket with an ordinary response: the body streams as produced, paced by the
 * socket's backpressure and delimited by the close (RFC 9112 section 6.3), never buffered whole. */
async function writeSocketResponse(
  socket: Duplex,
  response: Response,
  method: string,
): Promise<void> {
  let head = `HTTP/1.1 ${response.status} ${response.statusText || STATUS_CODES[response.status] || "Unknown"}\r\n`
  response.headers.forEach((value, key) => {
    if (key !== "connection" && key !== "keep-alive" && key !== "transfer-encoding") {
      head += `${key}: ${value}\r\n`
    }
  })
  socket.write(`${head}Connection: close\r\n\r\n`)
  if (response.body === null || method === "HEAD") {
    await response.body?.cancel().catch(() => {})
    socket.end()
    return
  }
  const reader = response.body.getReader()
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (!socket.write(chunk.value) && !(await waitForDrain(socket))) {
        await reader.cancel()
        return
      }
    }
    socket.end()
  } catch {
    socket.destroy()
    await reader.cancel().catch(() => {})
  }
}
