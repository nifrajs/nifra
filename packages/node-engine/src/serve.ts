/**
 * EXPERIMENTAL - not for release. Serve a nifra app on Nifra's Rust `libuv` engine (`nifra-napi`):
 * zero-copy `inMeta`/`inData` and `outMeta`/`outData` shared buffers, lazy header/body accessors, and
 * back-pressure-aware streaming over HTTP/1.1, HTTP/2, TLS and WebSocket.
 *
 *   import { serve } from "@nifrajs/node-engine"
 *   const running = await serve(app, { port: 3000 })
 *
 * Because the engine buffers a body before the app runs, `maxBodySize` bounds the memory one request
 * can hold (plus `oversizeWindow`, for answering a body only a little over it); set it to the largest
 * body any route accepts.
 */
import { existsSync } from "node:fs"
import { Module } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  activateAsyncContextFrame,
  enableNodeDirect,
  errorReporterOf,
  hostPolicyOf,
  lifecycleOf,
  type NodeServeOutcome,
  type NodeStopOptions,
  nodeOutcomeRuntime,
  resolveRequestHost,
  resolveRequestTarget,
} from "@nifrajs/node/transport"
import { declarativeRoutes, isServerView } from "./generated/declarative-routes.ts"
import { assertCloseArgs, exceedsPayloadCap } from "./generated/ws-close.ts"
import type { NifraWs, NifraWsData, WsUpgradeOutcome } from "./generated/ws-types.ts"
import {
  bodyCeiling,
  type EngineServer,
  type EngineSocket,
  type FetchHandler,
  isCap,
  mayServeSockets,
  payloadCeiling,
  type ServeOptions,
  type TlsOptions,
} from "./options.ts"

type WsUpgrade = Extract<WsUpgradeOutcome, { readonly kind: "upgrade" }>

const JSON_CONTENT_TYPE = Response.json(0).headers.get("content-type") ?? "application/json"
const INTERNAL_ERROR_BODY = '{"ok":false,"error":"internal_error"}'

const METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"] as const

// Bitflags matching `native/nifra-engine/crates/nifra-http/src/lib.rs` (`abi` module).
const METHOD_MASK = 0x0f
const FLAG_HAS_BODY = 1 << 4
const FLAG_IS_ASCII_BODY = 1 << 5
const FLAG_IS_WS_UPGRADE = 1 << 6
const FLAG_IS_H2 = 1 << 7
const FLAG_HOST_VALID = 1 << 8
const FLAG_OVER_MAX_BODY = 1 << 9
const FLAG_LARGE_BODY = 1 << 10
const FLAG_CHUNKED = 1 << 12
const FLAG_HAS_CT = 1 << 13

const DEFAULT_DRAIN_MS = 10_000
const DRAIN_POLL_MS = 10
const MAX_NATIVE_LENGTH = 0xffff_ffff
const DEFAULT_MAX_BODY_SIZE = 1_048_576
const MAX_BUFFERED_RESPONSE_BYTES = 2 * 1024 * 1024
const STREAM_CHUNK_BYTES = 256 * 1024
const DEFAULT_OVERSIZE_WINDOW = 1_048_576
const PAYLOAD_TOO_LARGE_BODY = '{"ok":false,"error":"payload_too_large"}'
const WEBSOCKET_REFUSAL = '{"ok":false,"error":"websocket_unsupported"}'
const BAD_REQUEST_BODY = "Bad Request"
const NO_BODY = new ArrayBuffer(0)
const WS_OPEN = 1
const WS_CLOSING = 2
const WS_CLOSED = 3

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const BAD_VALUE = /[^\t\x20-\x7e\x80-\xff]/

type HeaderRecord = Readonly<Record<string, string | readonly string[]>>

interface RustBatchBuffers {
  readonly inMeta: Uint32Array
  readonly inData: Buffer
  readonly outMeta: Uint32Array
  readonly outData: Buffer
  readonly inSlotU32s: number
  readonly outSlotU32s: number
}

interface RustTlsOptions {
  readonly cert: string | undefined
  readonly key: string | undefined
  readonly certFileName: string | undefined
  readonly keyFileName: string | undefined
  readonly ticketKeys: Buffer | undefined
}

interface RustUvServer {
  readonly port: number
  setStreamCallbacks(
    onWritable?: ((reqId: number) => void) | null,
    onAborted?: ((reqId: number) => void) | null,
  ): void
  setWsCallbacks(
    onOpen?: ((socketId: number) => void) | null,
    onMessage?: ((socketId: number, data: string | ArrayBuffer) => void) | null,
    onClose?: ((socketId: number, code: number, reason: string) => void) | null,
  ): void
  upgradeToWebSocket(reqId: number): number
  wsSend(socketId: number, payload: Buffer, isBinary: boolean): boolean
  wsSendText(socketId: number, text: string): boolean
  wsClose(socketId: number, code: number, reason?: string | null): boolean
  wsGetHeaders(socketId: number): string[]
  wsGetQuery(socketId: number): string
  wsGetRemoteAddress(socketId: number): string | null
  getBatchBuffers(): RustBatchBuffers
  getMethod(reqId: number): string | null
  getHeader(reqId: number, name: string): string | null
  getHeaders(reqId: number): string[]
  getBody(reqId: number): Buffer | null
  getRemoteAddress(reqId: number): string | null
  setStaticRoute(path: string, status: number, flatHeaders: string[], body: Buffer): void
  setParamRoute(prefix: string, suffix: string, status: number, flatHeaders: string[]): void
  prepareResponse(status: number, flatHeaders: string[]): number
  flushResponses(count: number): void
  respondPrepared(reqId: number, templateId: number, body: Buffer): boolean
  respond(
    reqId: number,
    status: number,
    flatHeaders?: string[] | null,
    body?: Buffer | null,
  ): boolean
  writeHead(
    reqId: number,
    status: number,
    flatHeaders?: string[] | null,
    contentLength?: number | null,
  ): boolean
  write(reqId: number, chunk: Buffer): boolean
  end(reqId: number, chunk?: Buffer | null): boolean
  abortStream(reqId: number): boolean
  reloadTls(tls: RustTlsOptions): void
  hasUnsentOutput(): boolean
  stopListening(): void
  close(): void
}

interface RustAddon {
  probe(): { readonly ok: boolean; readonly transport: string }
  createUvServer(
    host: string,
    port: number,
    onBatch: (count: number) => void,
    options?: {
      readonly maxBodySize?: number
      readonly oversizeWindow?: number
      readonly maxHeaderBytes?: number | undefined
      readonly idleTimeoutMs?: number | undefined
      readonly maxConnections?: number | undefined
      readonly requestTimeoutMs?: number | undefined
      readonly wsMaxMessageSize?: number | undefined
      readonly http2?: boolean | undefined
      readonly http2MaxConcurrentStreams?: number | undefined
      readonly reusePort?: boolean | undefined
      readonly tls?: RustTlsOptions | undefined
    },
  ): RustUvServer
}

function pemToString(value: string | ArrayBuffer | Uint8Array | undefined): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === "string") return value
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value)).toString("utf8")
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("utf8")
}

function toTicketBuffer(value: string | ArrayBuffer | Uint8Array | undefined): Buffer | undefined {
  if (value === undefined) return undefined
  if (typeof value === "string") return Buffer.from(value)
  if (Buffer.isBuffer(value)) return value
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value))
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
}

function toRustTls(tls: TlsOptions): RustTlsOptions {
  const cert = pemToString(tls.cert)
  const key = pemToString(tls.key)
  const ticketKeys = toTicketBuffer(tls.ticketKeys)
  return {
    cert,
    key,
    certFileName: tls.cert_file_name,
    keyFileName: tls.key_file_name,
    ticketKeys,
  }
}

let cachedAddon: RustAddon | undefined

function loadRustAddon(): RustAddon {
  if (cachedAddon !== undefined) return cachedAddon
  const explicit = process.env.NIFRA_RUST_ENGINE_PATH
  const here = dirname(fileURLToPath(import.meta.url))
  const engineRoot = resolve(here, "../../../native/nifra-engine")
  const library =
    process.platform === "win32"
      ? "nifra_napi.dll"
      : process.platform === "darwin"
        ? "libnifra_napi.dylib"
        : "libnifra_napi.so"
  const binary =
    explicit === undefined
      ? [`target/release/${library}`, `target/debug/${library}`, "nifra_napi.node"]
          .map((name) => join(engineRoot, name))
          .find(existsSync)
      : resolve(explicit)
  if (binary === undefined || !existsSync(binary)) {
    throw new TypeError(
      `@nifrajs/node-engine: a native addon is required at ${binary ?? engineRoot}. Run \`cargo build --release -p nifra-napi\` in native/nifra-engine or set NIFRA_RUST_ENGINE_PATH.`,
    )
  }
  const addon = new Module(binary)
  // Cargo uses the platform's shared library extension. Load it in place.
  process.dlopen(addon, binary)
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: native NAPI-RS addon conforms to RustAddon
  cachedAddon = addon.exports as RustAddon
  return cachedAddon
}

const isBodyless = (status: number): boolean => status === 204 || status === 205 || status === 304

function ownedHeader(name: string): boolean {
  const lower = name.toLowerCase()
  return lower === "date" || lower === "content-length" || lower === "transfer-encoding"
}

function validateHeaders(
  status: number,
  headers: HeaderRecord | undefined,
  cookies: readonly string[] | undefined,
): void {
  if (!Number.isInteger(status) || status < 100 || status > 999) {
    throw new RangeError(`Invalid status code: ${String(status)}`)
  }
  if (headers !== undefined) {
    for (const [name, value] of Object.entries(headers)) {
      if (!TOKEN.test(name)) throw new TypeError("Invalid character in header name")
      if (typeof value === "string") {
        if (BAD_VALUE.test(value)) throw new TypeError("Invalid character in header content")
      } else if (value !== undefined) {
        for (const each of value) {
          if (BAD_VALUE.test(each)) throw new TypeError("Invalid character in header content")
        }
      }
    }
  }
  if (cookies !== undefined) {
    for (const cookie of cookies) {
      if (BAD_VALUE.test(cookie)) throw new TypeError("Invalid character in header content")
    }
  }
}

function buildFlatHeaders(
  headers: HeaderRecord | undefined,
  cookies: readonly string[] | undefined,
  defaultType: string | undefined,
): string[] {
  const flat: string[] = []
  let typed = false
  if (headers !== undefined) {
    for (const [name, value] of Object.entries(headers)) {
      if (ownedHeader(name)) continue
      if (!typed && name.length === 12 && name.toLowerCase() === "content-type") typed = true
      if (typeof value === "string") flat.push(name, value)
      else if (value !== undefined) for (const each of value) flat.push(name, each)
    }
  }
  if (!typed && defaultType !== undefined) flat.push("content-type", defaultType)
  if (cookies !== undefined) for (const cookie of cookies) flat.push("set-cookie", cookie)
  return flat
}

/** A declared fixed reply's headers as the flat list the engine takes, or `undefined` when one could not be written (the router answers that route). */
function fixedHeaders(headers: readonly (readonly [string, string])[]): string[] | undefined {
  const flat: string[] = []
  for (const [name, value] of headers) {
    if (!TOKEN.test(name) || BAD_VALUE.test(value)) return undefined
    if (!ownedHeader(name)) flat.push(name, value)
  }
  return flat
}

const NO_BODY_BYTES = new Uint8Array(0)

function declaredContentLength(headers: HeaderRecord | undefined): number | undefined {
  if (headers === undefined) return undefined
  for (const [name, value] of Object.entries(headers)) {
    if (name.length !== 14 || name.toLowerCase() !== "content-length") continue
    const text = typeof value === "string" ? value : value?.[0]
    if (text === undefined || !/^\d{1,15}$/.test(text)) return undefined
    return Number(text)
  }
  return undefined
}

function parseJsonBytes(bytes: Uint8Array): unknown {
  const skip = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0
  return JSON.parse(
    Buffer.from(bytes.buffer, bytes.byteOffset + skip, bytes.byteLength - skip).toString("utf8"),
  )
}

/** Request view backed by the zero-copy `inData` slice with lazy FFI fallback for headers/bodies. */
class RustBatchSource {
  readonly method: string
  readonly urlParts: { readonly pathname: string; readonly search: string }
  aborted = false
  settled = false
  headWritten = false
  onAbort: (() => void) | undefined
  onWritable: (() => void) | undefined

  private readonly server: RustUvServer
  private id: number
  private readonly flags: number
  private readonly protocol: string
  private readonly target: string
  private readonly authority: string | undefined
  private readonly bodyLen: number
  private bodyText: string | null
  private bodyBytes: Uint8Array | null | undefined
  /** The request's first `Content-Type`: `null` when it had none, `undefined` when not carried (ask the engine). */
  private readonly contentType: string | null | undefined
  private peer: string | undefined
  private urlValue: string | undefined
  private headersValue: Headers | undefined
  private requestValue: Request | undefined
  private controller: AbortController | undefined

  constructor(
    server: RustUvServer,
    id: number,
    method: string,
    pathname: string,
    search: string,
    target: string,
    authority: string | undefined,
    flags: number,
    protocol: string,
    bodyLen: number,
    bodyText: string | null,
    bodyBytes: Uint8Array | null | undefined,
    contentType: string | null | undefined,
  ) {
    this.server = server
    this.id = id
    this.method = method
    this.urlParts = { pathname, search }
    this.target = target
    this.authority = authority
    this.flags = flags
    this.protocol = protocol
    this.bodyLen = bodyLen
    this.bodyText = bodyText
    this.bodyBytes = bodyBytes
    this.contentType = contentType
  }

  get requestId(): number {
    return this.id
  }

  get isH2(): boolean {
    return (this.flags & FLAG_IS_H2) !== 0
  }

  release(): void {
    this.id = -1
  }

  abort(): void {
    if (this.aborted) return
    this.aborted = true
    this.controller?.abort()
    this.onAbort?.()
    this.onWritable?.()
  }

  get clientIp(): string | undefined {
    if (this.peer === undefined && this.id >= 0) {
      this.peer = this.server.getRemoteAddress(this.id) ?? undefined
    }
    return this.peer
  }

  get url(): string {
    if (this.urlValue === undefined) {
      const host =
        this.authority ??
        (this.id >= 0 ? this.server.getHeader(this.id, "host") : null) ??
        "localhost"
      this.urlValue = `${this.protocol}://${host}${this.target}`
    }
    return this.urlValue
  }

  header(name: string): string | null {
    if (name === "content-type" && this.contentType !== undefined) return this.contentType
    if (name === "content-length" && (this.flags & FLAG_CHUNKED) === 0) {
      if ((this.flags & FLAG_HAS_BODY) !== 0) return String(this.bodyLen)
    }
    if (name === "transfer-encoding") {
      return (this.flags & FLAG_CHUNKED) !== 0 ? "chunked" : null
    }
    const lower = name.toLowerCase()
    if (lower === "transfer-encoding") {
      return (this.flags & FLAG_CHUNKED) !== 0 ? "chunked" : null
    }
    if (lower === "content-length" && (this.flags & FLAG_CHUNKED) === 0) {
      if ((this.flags & FLAG_HAS_BODY) !== 0) return String(this.bodyLen)
    }
    if (lower === "content-type" && this.contentType !== undefined) return this.contentType
    if (this.id < 0) return null
    return this.server.getHeader(this.id, lower)
  }

  get headers(): Headers {
    if (this.headersValue === undefined) {
      const pairs = this.id < 0 ? [] : this.server.getHeaders(this.id)
      const h = new Headers()
      for (let i = 0; i < pairs.length; i += 2) {
        h.append(pairs[i] ?? "", pairs[i + 1] ?? "")
      }
      this.headersValue = h
    }
    return this.headersValue
  }

  private toBytes(): Uint8Array | null {
    if (this.bodyBytes !== undefined) return this.bodyBytes
    if (this.bodyText !== null) {
      this.bodyBytes = Buffer.from(this.bodyText)
      return this.bodyBytes
    }
    if ((this.flags & FLAG_HAS_BODY) === 0 || this.id < 0) {
      this.bodyBytes = null
      return null
    }
    const buf = this.server.getBody(this.id)
    this.bodyBytes =
      buf === null ? null : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    return this.bodyBytes
  }

  get body(): ReadableStream<Uint8Array> | null {
    const bytes = this.toBytes()
    if (bytes === null) return null
    return new ReadableStream<Uint8Array>({
      start(controller) {
        if (bytes.byteLength > 0) controller.enqueue(bytes)
        controller.close()
      },
    })
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    const bytes = this.toBytes()
    if (bytes === null) return Promise.resolve(NO_BODY)
    // Exactly the body's bytes: `bytes` may be a view into a pooled Buffer.
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes)
    return Promise.resolve(copy.buffer)
  }

  bytes(): Promise<Uint8Array> {
    // A copy, as `arrayBuffer()`: the view's `.buffer` would expose the rest of a pooled Buffer.
    return Promise.resolve(new Uint8Array(this.toBytes() ?? NO_BODY_BYTES))
  }

  jsonNow(): { readonly value: unknown; readonly byteLength: number } {
    if (this.bodyText !== null) {
      return { value: JSON.parse(this.bodyText), byteLength: this.bodyText.length }
    }
    const bytes = this.toBytes()
    if (bytes === null) return { value: JSON.parse(""), byteLength: 0 }
    return { value: parseJsonBytes(bytes), byteLength: bytes.byteLength }
  }

  json(): Promise<unknown> {
    try {
      return Promise.resolve(this.jsonNow().value)
    } catch (error) {
      return Promise.reject(error)
    }
  }

  jsonWithByteLength(): Promise<{ readonly value: unknown; readonly byteLength: number }> {
    try {
      return Promise.resolve(this.jsonNow())
    } catch (error) {
      return Promise.reject(error)
    }
  }

  rawBodyReaders(): {
    readonly headers: Pick<Headers, "get">
    readonly body: ReadableStream<Uint8Array> | null
    arrayBuffer(): Promise<ArrayBuffer>
    bytes(): Promise<Uint8Array>
    json(): Promise<unknown>
  } {
    const source = this
    return {
      headers: { get: (name: string) => source.header(name) },
      get body() {
        return source.body
      },
      arrayBuffer: () => source.arrayBuffer(),
      bytes: () => source.bytes(),
      json: () => source.json(),
    }
  }

  get request(): Request {
    if (this.requestValue === undefined) {
      const controller = new AbortController()
      if (this.aborted) controller.abort()
      this.controller = controller
      const init: RequestInit = {
        method: this.method,
        headers: this.headers,
        signal: controller.signal,
      }
      const bytes = this.method === "GET" || this.method === "HEAD" ? null : this.toBytes()
      if (bytes !== null) init.body = bytes.slice()
      this.requestValue = new Request(this.url, init)
    }
    return this.requestValue
  }
}

interface RustWsEntry {
  readonly nifra: NifraWs
  readonly upgrade: WsUpgrade
  state: number
  sentClose: readonly [number, string] | undefined
  readonly safe: (call: () => void | Promise<void>) => void
  readonly reportError: (error: unknown) => void
  readonly closeSocket: (code?: number, reason?: string) => void
}

const UNSUPPORTED_OPTIONS = ["static", "fastResponse"] as const

export function serve(app: FetchHandler, options: ServeOptions): Promise<EngineServer> {
  for (const name of UNSUPPORTED_OPTIONS) {
    if (name in options) {
      throw new TypeError(
        `@nifrajs/node-engine: \`${name}\` is not supported; serve files from a route or put a static host in front`,
      )
    }
  }
  if (typeof options.port !== "number" || !Number.isInteger(options.port) || options.port < 0) {
    throw new TypeError("@nifrajs/node-engine: `port` must be a non-negative integer")
  }
  if (
    options.maxBodySize !== undefined &&
    !(isCap(options.maxBodySize) && options.maxBodySize <= MAX_NATIVE_LENGTH)
  ) {
    throw new TypeError("@nifrajs/node-engine: `maxBodySize` must be a positive integer below 2^32")
  }
  if (
    options.oversizeWindow !== undefined &&
    !(
      Number.isSafeInteger(options.oversizeWindow) &&
      options.oversizeWindow >= 0 &&
      options.oversizeWindow <= MAX_NATIVE_LENGTH
    )
  ) {
    throw new TypeError(
      "@nifrajs/node-engine: `oversizeWindow` must be a non-negative integer below 2^32",
    )
  }
  if (options.validateHost !== undefined && typeof options.validateHost !== "boolean") {
    throw new TypeError("@nifrajs/node-engine: `validateHost` must be a boolean")
  }
  const hasHostPolicy = options.allowedHosts !== undefined || options.canonicalHost !== undefined
  if (options.validateHost === false && hasHostPolicy) {
    throw new TypeError(
      "@nifrajs/node-engine: `validateHost: false` is not supported with `allowedHosts` or `canonicalHost`",
    )
  }
  const policy = hostPolicyOf(options)
  const protocol = options.protocol ?? (options.tls === undefined ? "http" : "https")
  if (protocol !== "http" && protocol !== "https") {
    throw new TypeError(`@nifrajs/node-engine: protocol must be "http" or "https"`)
  }

  const addon = loadRustAddon()
  activateAsyncContextFrame()
  enableNodeDirect(app)
  const report = errorReporterOf(app)
  const lifecycle = lifecycleOf(app)
  const resolveNodeSource = app.resolveNodeSource
  const resolveWs = app.resolveWebSocketUpgrade
  const checkUpgrade = resolveWs === undefined || mayServeSockets(app)
  const policedHost = options.allowedHosts !== undefined || options.canonicalHost !== undefined
  const checkHost = options.validateHost === true || policedHost
  const host = options.hostname ?? "0.0.0.0"

  // The native caps are u32: a larger one, the app's own included, is held to the largest it takes.
  const wsDeclared = options.wsMaxMessageSize ?? payloadCeiling(app)
  const wsCap = wsDeclared === undefined ? undefined : Math.min(wsDeclared, MAX_NATIVE_LENGTH)
  const maxBodySize = Math.min(
    options.maxBodySize ?? Math.max(DEFAULT_MAX_BODY_SIZE, bodyCeiling(app) ?? 0),
    MAX_NATIVE_LENGTH,
  )
  const oversizeWindow = options.oversizeWindow ?? DEFAULT_OVERSIZE_WINDOW

  let uvServer: RustUvServer
  let bufs: RustBatchBuffers
  const inflight = new Map<number, RustBatchSource>()
  const wsSockets = new Map<number, RustWsEntry>()
  let openingWs: WsUpgrade | undefined
  const jsonTemplates = new Map<number, number>()
  const textTemplates = new Map<number, number>()
  let tpl400 = 0
  let tpl413 = 0
  let tpl500 = 0
  let tpl501 = 0

  const jsonTemplate = (status: number): number => {
    let id = jsonTemplates.get(status)
    if (id === undefined) {
      id = uvServer.prepareResponse(status, ["content-type", JSON_CONTENT_TYPE])
      jsonTemplates.set(status, id)
    }
    return id
  }

  const textTemplate = (status: number): number => {
    let id = textTemplates.get(status)
    if (id === undefined) {
      id = uvServer.prepareResponse(status, ["content-type", "text/plain; charset=utf-8"])
      textTemplates.set(status, id)
    }
    return id
  }

  const finish = (source: RustBatchSource): void => {
    if (source.settled) return
    source.settled = true
    inflight.delete(source.requestId)
    source.release()
  }

  const fail = (source: RustBatchSource, error: unknown): void => {
    try {
      report?.(error)
    } catch {
      // ignore logger errors
    }
    if (!source.aborted && !source.settled) {
      if (source.headWritten) {
        // A clean end would tell the client (and any cache) the truncated body is whole.
        uvServer.abortStream(source.requestId)
      } else {
        uvServer.respondPrepared(source.requestId, tpl500, Buffer.from(INTERNAL_ERROR_BODY))
        source.headWritten = true
      }
    }
    finish(source)
  }

  const writeBuffered = (
    source: RustBatchSource,
    status: number,
    headers: HeaderRecord | undefined,
    cookies: readonly string[] | undefined,
    body: string | Uint8Array | null,
    isHead: boolean,
    defaultType: string | undefined,
    headLength?: number,
  ): void => {
    validateHeaders(status, headers, cookies)
    const bodyless = isBodyless(status)
    const flat = buildFlatHeaders(
      headers,
      cookies,
      bodyless || body === null ? undefined : defaultType,
    )
    if (isHead && !bodyless) {
      const len =
        headLength ??
        (body === null ? 0 : typeof body === "string" ? Buffer.byteLength(body) : body.byteLength)
      flat.push("content-length", String(len))
      uvServer.respond(source.requestId, status, flat, null)
    } else {
      const buf =
        bodyless || body === null
          ? null
          : typeof body === "string"
            ? Buffer.from(body)
            : Buffer.from(body.buffer, body.byteOffset, body.byteLength)
      uvServer.respond(source.requestId, status, flat, buf)
    }
    source.headWritten = true
  }

  const pumpStream = async (
    source: RustBatchSource,
    status: number,
    headers: HeaderRecord | undefined,
    cookies: readonly string[] | undefined,
    stream: ReadableStream<Uint8Array>,
    defaultType?: string,
    bodyLength?: number,
  ): Promise<void> => {
    const reader = stream.getReader()
    let unblock: (() => void) | undefined
    source.onAbort = () => {
      void reader.cancel().catch(() => {})
      unblock?.()
    }
    source.onWritable = () => unblock?.()

    const declared = bodyLength ?? declaredContentLength(headers)
    // Only a body that completes at once can still be sent, at its real length: do not wait on one.
    const unframeable = declared !== undefined && declared > MAX_NATIVE_LENGTH
    const pending: Uint8Array[] = []
    let finished = false
    // A second read that is still pending after a turn is not waited for: a route that sent its first
    // event and then waits on something external must not hold that event back.
    let carried: ReturnType<typeof reader.read> | undefined
    for (let i = 0; i < 2 && !finished; i++) {
      const read = reader.read()
      let next: Awaited<ReturnType<typeof reader.read>> | undefined
      if (!unframeable && (i === 0 || pending.length === 0)) {
        next = await read
      } else {
        next = await Promise.race([read, new Promise<undefined>((r) => setImmediate(r))])
        if (next === undefined) carried = read
      }
      if (source.aborted) return
      if (next === undefined) break
      if (next.done) finished = true
      else if (next.value.byteLength > 0) pending.push(next.value)
    }

    if (finished && (pending[0]?.byteLength ?? 0) <= MAX_BUFFERED_RESPONSE_BYTES) {
      const [first] = pending
      const only =
        first === undefined ? null : pending.length === 1 ? first : Buffer.concat(pending)
      writeBuffered(source, status, headers, cookies, only, false, defaultType)
      return
    }

    validateHeaders(status, headers, cookies)
    const flat = buildFlatHeaders(headers, cookies, defaultType)
    // The native writer takes a u32 and would wrap a larger value into a short, wrong length.
    if (unframeable) {
      void reader.cancel().catch(() => {})
      throw new RangeError(`Content-Length ${declared} is larger than the engine can frame`)
    }
    uvServer.writeHead(source.requestId, status, flat, declared ?? null)
    source.headWritten = true

    let sent = 0
    let done = false
    const sendChunk = async (chunk: Uint8Array): Promise<void> => {
      if (declared !== undefined && sent + chunk.byteLength > declared) {
        void reader.cancel().catch(() => {})
        throw new RangeError("response body is longer than its Content-Length")
      }
      for (
        let offset = 0;
        offset < chunk.byteLength && !source.aborted;
        offset += STREAM_CHUNK_BYTES
      ) {
        const len = Math.min(STREAM_CHUNK_BYTES, chunk.byteLength - offset)
        const buf = Buffer.from(chunk.buffer, chunk.byteOffset + offset, len)
        sent += len
        if (declared !== undefined && sent === declared) {
          void reader.cancel().catch(() => {})
          uvServer.end(source.requestId, buf)
          done = true
          return
        }
        if (!uvServer.write(source.requestId, buf)) {
          await new Promise<void>((resolveWrite) => {
            unblock = resolveWrite
          })
        }
      }
    }

    for (const chunk of pending) {
      await sendChunk(chunk)
      if (source.aborted || done) return
    }
    for (;;) {
      const next = await (carried ?? reader.read())
      carried = undefined
      if (source.aborted) return
      if (next.done) break
      if (next.value.byteLength === 0) continue
      await sendChunk(next.value)
      if (source.aborted || done) return
    }
    if (declared !== undefined && sent !== declared) {
      throw new RangeError("response body is shorter than its Content-Length")
    }
    uvServer.end(source.requestId, null)
  }

  const writeComplexOutcome = (
    source: RustBatchSource,
    outcome: NodeServeOutcome,
    isHead: boolean,
    defaultBodyType?: string,
  ): void => {
    if (source.aborted || source.settled) return
    try {
      if (outcome.kind === "json" || outcome.kind === "body") {
        const { body, headers, status } = outcome
        const cookies = outcome.kind === "json" ? outcome.cookies : undefined
        const type = outcome.kind === "json" ? JSON_CONTENT_TYPE : defaultBodyType
        const len = typeof body === "string" ? Buffer.byteLength(body) : (body?.byteLength ?? 0)
        if (
          headers === undefined &&
          cookies === undefined &&
          !isHead &&
          !isBodyless(status) &&
          len <= MAX_BUFFERED_RESPONSE_BYTES &&
          (outcome.kind === "json" || defaultBodyType === "text/plain; charset=utf-8")
        ) {
          const buf =
            body === null || body === undefined
              ? Buffer.alloc(0)
              : typeof body === "string"
                ? Buffer.from(body)
                : Buffer.from(body.buffer, body.byteOffset, body.byteLength)
          const tpl = outcome.kind === "json" ? jsonTemplate(status) : textTemplate(status)
          uvServer.respondPrepared(source.requestId, tpl, buf)
          source.headWritten = true
          finish(source)
          return
        }
        if (
          body !== null &&
          body !== undefined &&
          !isHead &&
          !isBodyless(status) &&
          len > MAX_BUFFERED_RESPONSE_BYTES
        ) {
          const bytes = typeof body === "string" ? Buffer.from(body) : body
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes)
              controller.close()
            },
          })
          pumpStream(source, status, headers, cookies, stream, type, len).then(
            () => finish(source),
            (err: unknown) => fail(source, err),
          )
        } else {
          writeBuffered(source, status, headers, cookies, body, isHead, type, len)
          finish(source)
        }
        return
      }
      const response = outcome.response
      const headers: Record<string, string> = {}
      response.headers.forEach((value, name) => {
        if (name !== "set-cookie") headers[name] = value
      })
      const cookies = response.headers.getSetCookie()
      const status = response.status
      const stream = response.body
      if (stream === null || isBodyless(status)) {
        writeBuffered(
          source,
          status,
          headers,
          cookies,
          null,
          isHead,
          undefined,
          isHead ? declaredContentLength(headers) : undefined,
        )
        finish(source)
        return
      }
      if (isHead) {
        void stream.cancel().catch(() => {})
        writeBuffered(
          source,
          status,
          headers,
          cookies,
          null,
          true,
          undefined,
          declaredContentLength(headers) ?? 0,
        )
        finish(source)
        return
      }
      pumpStream(source, status, headers, cookies, stream).then(
        () => finish(source),
        (err: unknown) => fail(source, err),
      )
    } catch (err) {
      fail(source, err)
    }
  }

  const outcomeOf = (source: RustBatchSource): NodeServeOutcome | Promise<NodeServeOutcome> =>
    resolveNodeSource === undefined
      ? Promise.resolve(app.fetch(source.request, source)).then(
          (response): NodeServeOutcome => ({ kind: "response", response }),
        )
      : resolveNodeSource.call(app, source, source, nodeOutcomeRuntime)

  // The shared out slab: a sync outcome fills it during `onBatch`, which flushes at its end; an outcome
  // that settles later (a body still being read) fills it from a microtask, flushed at the end of that
  // microtask checkpoint, so a POST costs one batched native call like a GET and not one call each.
  let outMeta!: Uint32Array
  let outData!: Buffer
  let outSlotU32s = 0
  let maxOutBytes = 0
  let outCount = 0
  let outOff = 0
  let flushScheduled = false

  const flush = (): void => {
    if (outCount === 0) return
    uvServer.flushResponses(outCount)
    outCount = 0
    outOff = 0
  }

  const queueSync = (reqId: number, templateId: number, body: string | Uint8Array): boolean => {
    const room = maxOutBytes - outOff
    // A conservative bound keeps the small string fast path to one UTF-8 pass.
    const fits = typeof body === "string" ? body.length * 3 <= room : body.byteLength <= room
    if ((outCount + 1) * outSlotU32s > outMeta.length || !fits) {
      const len = typeof body === "string" ? Buffer.byteLength(body) : body.byteLength
      if (len > room || (outCount + 1) * outSlotU32s > outMeta.length) flush()
      if (len > maxOutBytes) return false
    }
    const len = typeof body === "string" ? outData.write(body, outOff, "utf8") : body.byteLength
    if (typeof body !== "string") outData.set(body, outOff)
    const ob = outCount * outSlotU32s
    outMeta[ob] = reqId
    outMeta[ob + 1] = templateId
    outMeta[ob + 2] = outOff
    outMeta[ob + 3] = len
    outOff += len
    outCount += 1
    return true
  }

  const flushSoon = (): void => {
    if (flushScheduled) return
    flushScheduled = true
    queueMicrotask(() => {
      flushScheduled = false
      flush()
    })
  }

  /** Queues a plain json or text outcome into the out slab; `false` when it needs the full writer. */
  const queueOutcome = (reqId: number, outcome: NodeServeOutcome, isHead: boolean): boolean => {
    if (isHead || outcome.kind === "response") return false
    if (outcome.headers !== undefined || isBodyless(outcome.status)) return false
    if (outcome.kind === "json") {
      return (
        outcome.cookies === undefined &&
        queueSync(reqId, jsonTemplate(outcome.status), outcome.body ?? "")
      )
    }
    return queueSync(reqId, textTemplate(outcome.status), outcome.body ?? "")
  }

  const settleOutcome = (
    source: RustBatchSource,
    outcome: NodeServeOutcome,
    isHead: boolean,
  ): void => {
    if (!source.aborted && !source.settled && queueOutcome(source.requestId, outcome, isHead)) {
      finish(source)
      flushSoon()
      return
    }
    writeComplexOutcome(source, outcome, isHead)
  }

  const onBatch = (count: number): void => {
    const { inMeta, inData, inSlotU32s } = bufs

    for (let i = 0; i < count; i++) {
      const b = i * inSlotU32s
      const reqId = inMeta[b] ?? 0
      const flags = inMeta[b + 1] ?? 0

      let authority: string | undefined
      if (policedHost) {
        authority = resolveRequestHost(uvServer.getHeader(reqId, "host") ?? undefined, policy)
        if (authority === undefined) {
          queueSync(reqId, tpl400, BAD_REQUEST_BODY)
          continue
        }
      } else if (checkHost) {
        // The engine's syntax check is the cheap early refusal; the authority is then normalised as
        // a Host policy would, so `EXAMPLE.COM:080` builds the same URL under either option.
        if ((flags & FLAG_HOST_VALID) === 0) {
          queueSync(reqId, tpl400, BAD_REQUEST_BODY)
          continue
        }
        authority = resolveRequestHost(uvServer.getHeader(reqId, "host") ?? undefined, policy)
        if (authority === undefined) {
          queueSync(reqId, tpl400, BAD_REQUEST_BODY)
          continue
        }
      }

      if ((flags & FLAG_OVER_MAX_BODY) !== 0) {
        queueSync(reqId, tpl413, PAYLOAD_TOO_LARGE_BODY)
        continue
      }

      const methodIdx = flags & METHOD_MASK
      const method =
        methodIdx < METHODS.length
          ? (METHODS[methodIdx] ?? "GET")
          : (uvServer.getMethod(reqId) ?? "GET")
      const isHead = methodIdx === 5
      const pathOff = inMeta[b + 2] ?? 0
      const pathLen = inMeta[b + 3] ?? 0
      const queryOff = inMeta[b + 4] ?? 0
      const queryLen = inMeta[b + 5] ?? 0
      const bodyOff = inMeta[b + 6] ?? 0
      const bodyLen = inMeta[b + 7] ?? 0
      const ctOff = inMeta[b + 8] ?? 0
      const ctLen = inMeta[b + 9] ?? 0

      const rawPath = inData.toString("latin1", pathOff, pathOff + pathLen)
      const rawQuery =
        queryLen === 0 ? "" : inData.toString("latin1", queryOff, queryOff + queryLen)
      const asSent = queryLen === 0 ? rawPath : `${rawPath}?${rawQuery}`
      const target = resolveRequestTarget(asSent, policy.normalizeTarget)
      const queryStart =
        target === asSent ? (queryLen === 0 ? -1 : rawPath.length) : target.indexOf("?")
      const pathname = queryStart === -1 ? target : target.slice(0, queryStart)
      const search = queryStart === -1 ? "" : target.slice(queryStart)

      let bodyText: string | null = null
      let bodyBytes: Uint8Array | null | undefined
      if ((flags & FLAG_HAS_BODY) !== 0 && (flags & FLAG_LARGE_BODY) === 0) {
        if ((flags & FLAG_IS_ASCII_BODY) !== 0) {
          bodyText = inData.toString("latin1", bodyOff, bodyOff + bodyLen)
        } else {
          // `Buffer#slice` is a view of the batch, which the next batch overwrites: copy the bytes.
          bodyBytes = new Uint8Array(bodyLen)
          bodyBytes.set(inData.subarray(bodyOff, bodyOff + bodyLen))
        }
      } else if ((flags & FLAG_HAS_BODY) === 0) {
        bodyBytes = null
      }

      // Carried in the batch, which the next one overwrites; a request with a body is where it is read.
      let contentType: string | null | undefined
      if ((flags & FLAG_HAS_BODY) !== 0) {
        contentType =
          (flags & FLAG_HAS_CT) === 0 ? null : inData.toString("latin1", ctOff, ctOff + ctLen)
      }

      const isWsHandshake = checkUpgrade && methodIdx === 0 && (flags & FLAG_IS_WS_UPGRADE) !== 0
      if (isWsHandshake && resolveWs === undefined) {
        queueSync(reqId, tpl501, WEBSOCKET_REFUSAL)
        continue
      }

      const source = new RustBatchSource(
        uvServer,
        reqId,
        method,
        pathname,
        search,
        target,
        authority,
        flags,
        protocol,
        bodyLen,
        bodyText,
        bodyBytes,
        contentType,
      )

      if (isWsHandshake) {
        inflight.set(reqId, source)
        upgradeSocket(source)
        continue
      }

      try {
        const outcome = outcomeOf(source)

        if (outcome instanceof Promise) {
          inflight.set(reqId, source)
          outcome.then(
            (settled) => settleOutcome(source, settled, isHead),
            (err: unknown) => fail(source, err),
          )
        } else if (queueOutcome(reqId, outcome, isHead)) {
          source.settled = true
          source.release()
        } else {
          inflight.set(reqId, source)
          const defaultType =
            outcome.kind === "body" && outcome.headers === undefined && !isHead
              ? "text/plain; charset=utf-8"
              : undefined
          writeComplexOutcome(source, outcome, isHead, defaultType)
        }
      } catch (err) {
        report?.(err)
        queueSync(reqId, tpl500, INTERNAL_ERROR_BODY)
        source.settled = true
        source.release()
      }
    }

    flush()
  }

  const dispatchHttp = (source: RustBatchSource): void => {
    try {
      const outcome = outcomeOf(source)
      if (outcome instanceof Promise) {
        outcome.then(
          (settled) => writeComplexOutcome(source, settled, false),
          (err: unknown) => fail(source, err),
        )
      } else {
        writeComplexOutcome(source, outcome, false)
      }
    } catch (err) {
      fail(source, err)
    }
  }

  let closed = false
  const upgradeSocket = (source: RustBatchSource): void => {
    if (closed) {
      uvServer.respond(
        source.requestId,
        503,
        ["content-type", JSON_CONTENT_TYPE],
        Buffer.from('{"ok":false,"error":"shutting_down"}'),
      )
      source.headWritten = true
      finish(source)
      return
    }
    const settle = (outcome: WsUpgradeOutcome): void => {
      if (source.aborted || source.settled) return
      try {
        if (outcome.kind === "pass") {
          dispatchHttp(source)
        } else if (outcome.kind === "reject") {
          writeComplexOutcome(source, { kind: "response", response: outcome.response }, false)
        } else if (closed) {
          // The resolver settled after shutdown swept the sockets: this one would miss the sweep.
          uvServer.respond(
            source.requestId,
            503,
            ["content-type", JSON_CONTENT_TYPE],
            Buffer.from('{"ok":false,"error":"shutting_down"}'),
          )
          source.headWritten = true
          finish(source)
        } else {
          openingWs = outcome
          let socketId: number
          try {
            socketId = uvServer.upgradeToWebSocket(source.requestId)
          } finally {
            openingWs = undefined
          }
          if (socketId < 0) {
            uvServer.respond(
              source.requestId,
              400,
              ["content-type", JSON_CONTENT_TYPE],
              Buffer.from('{"ok":false,"error":"bad_request"}'),
            )
            source.headWritten = true
          }
          finish(source)
        }
      } catch (err) {
        fail(source, err)
      }
    }
    try {
      if (resolveWs === undefined) throw new TypeError("no WebSocket upgrade seam")
      const outcome = resolveWs.call(app, source.request, source)
      if (outcome instanceof Promise) {
        outcome.then(settle, (err: unknown) => {
          if (!source.aborted && !source.settled) fail(source, err)
        })
      } else {
        settle(outcome)
      }
    } catch (err) {
      fail(source, err)
    }
  }

  const openWs = (id: number, upgrade: WsUpgrade): void => {
    const { handler, data, pubsub } = upgrade
    const rawSend = (payload: string | ArrayBufferView | ArrayBuffer): void => {
      if (entry.state !== WS_OPEN) return
      if (typeof payload === "string") {
        uvServer.wsSendText(id, payload)
      } else if (payload instanceof ArrayBuffer) {
        uvServer.wsSend(id, Buffer.from(payload), true)
      } else {
        uvServer.wsSend(
          id,
          Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength),
          true,
        )
      }
    }
    const closeSocket = (code = 1000, reason?: string): void => {
      if (entry.state !== WS_OPEN) return
      entry.state = WS_CLOSING
      entry.sentClose = [code, reason ?? ""]
      uvServer.wsClose(id, code, reason ?? "")
    }
    const reportError = (error: unknown): void => {
      if (handler.error === undefined) return
      try {
        const settled = handler.error(nifra, error)
        if (settled instanceof Promise) settled.catch(() => {})
      } catch {
        // ignore error handler failures
      }
    }
    const safe = (call: () => void | Promise<void>): void => {
      try {
        const settled = call()
        if (settled instanceof Promise) settled.catch(reportError)
      } catch (error) {
        reportError(error)
      }
    }
    const handle: EngineSocket = {
      id,
      headers: () => {
        const flat = uvServer.wsGetHeaders(id)
        const h = new Headers()
        for (let i = 0; i < flat.length; i += 2) h.append(flat[i] ?? "", flat[i + 1] ?? "")
        return h
      },
      query: () => uvServer.wsGetQuery(id),
      remoteAddress: () => uvServer.wsGetRemoteAddress(id) ?? undefined,
    }
    const nifra: NifraWs = {
      send: upgrade.sender === undefined ? rawSend : upgrade.sender(handler, rawSend, reportError),
      close: (code, reason) => {
        assertCloseArgs(code, reason)
        closeSocket(code, reason)
      },
      get readyState() {
        return entry.state
      },
      subscribe: (topic) => pubsub.subscribe(topic, nifra),
      unsubscribe: (topic) => pubsub.unsubscribe(topic, nifra),
      data,
      raw: handle,
    }
    const entry: RustWsEntry = {
      nifra,
      upgrade,
      state: WS_OPEN,
      sentClose: undefined,
      safe,
      reportError,
      closeSocket,
    }
    wsSockets.set(id, entry)
    safe(() => handler.open?.(nifra))
  }

  let currentTls = options.tls
  const http2Enabled = options.http2 !== undefined && options.http2 !== false
  const http2MaxStreams =
    typeof options.http2 === "object" && options.http2 !== null
      ? options.http2.maxConcurrentStreams
      : undefined
  const rawIdle = options.engine?.idleTimeoutMs
  const idleTimeoutMs =
    typeof rawIdle === "number" && Number.isFinite(rawIdle) && rawIdle >= 0
      ? Math.round(rawIdle)
      : undefined
  const rawRequest = options.engine?.requestTimeoutMs
  const requestTimeoutMs =
    typeof rawRequest === "number" && Number.isFinite(rawRequest) && rawRequest >= 0
      ? Math.round(rawRequest)
      : undefined
  const rawMax = options.engine?.maxConnections
  const maxConnections =
    typeof rawMax === "number" && Number.isInteger(rawMax) && rawMax > 0 ? rawMax : undefined
  try {
    uvServer = addon.createUvServer(host, options.port, onBatch, {
      maxBodySize,
      oversizeWindow,
      idleTimeoutMs,
      maxConnections,
      requestTimeoutMs,
      reusePort: options.engine?.reusePort,
      wsMaxMessageSize: wsCap,
      http2: http2Enabled ? true : undefined,
      http2MaxConcurrentStreams: http2MaxStreams,
      tls: currentTls === undefined ? undefined : toRustTls(currentTls),
    })
  } catch (cause) {
    return Promise.reject(
      new Error(`@nifrajs/node-engine: port ${options.port} is not available to listen on`, {
        cause,
      }),
    )
  }
  const abortRequest = (reqId: number): void => {
    const source = inflight.get(reqId)
    if (source === undefined) return
    source.abort()
    finish(source)
  }
  const finishSocket = (socketId: number, code: number, peerReason: string): void => {
    const entry = wsSockets.get(socketId)
    if (entry === undefined) return
    wsSockets.delete(socketId)
    entry.state = WS_CLOSED
    const { handler, pubsub } = entry.upgrade
    try {
      pubsub.unsubscribeAll(entry.nifra)
    } catch (error) {
      entry.reportError(error)
    }
    const [finalCode, finalReason] = entry.sentClose ?? [
      code,
      peerReason || (code === 1009 ? "message too large" : ""),
    ]
    entry.safe(() => handler.close?.(entry.nifra, finalCode, finalReason))
  }
  uvServer.setStreamCallbacks((reqId) => inflight.get(reqId)?.onWritable?.(), abortRequest)
  uvServer.setWsCallbacks(
    (socketId) => {
      if (openingWs !== undefined) openWs(socketId, openingWs)
    },
    (socketId, data) => {
      const entry = wsSockets.get(socketId)
      if (entry === undefined || entry.state !== WS_OPEN) return
      const { handler, maxPayloadBytes } = entry.upgrade
      if (maxPayloadBytes !== undefined && exceedsPayloadCap(data, maxPayloadBytes)) {
        entry.closeSocket(1009, "message too large")
        return
      }
      const payload: NifraWsData = typeof data === "string" ? data : new Uint8Array(data)
      entry.safe(() => handler.message?.(entry.nifra, payload))
    },
    finishSocket,
  )
  bufs = uvServer.getBatchBuffers()
  outMeta = bufs.outMeta
  outData = bufs.outData
  outSlotU32s = bufs.outSlotU32s
  maxOutBytes = outData.byteLength
  tpl400 = textTemplate(400)
  tpl413 = jsonTemplate(413)
  tpl500 = jsonTemplate(500)
  tpl501 = jsonTemplate(501)

  // Register staticResponse() and echoParam() GET routes natively in Rust (0 JS calls).
  if (isServerView(app) && !checkHost && !policy.normalizeTarget) {
    for (const route of declarativeRoutes(app)) {
      if (route.method !== "GET") continue
      const flat = fixedHeaders(route.headers)
      if (flat === undefined) continue
      if (route.param !== undefined) {
        uvServer.setParamRoute(
          route.path.slice(0, route.path.lastIndexOf(":")),
          "",
          route.status,
          flat,
        )
      } else {
        uvServer.setStaticRoute(route.path, route.status, flat, Buffer.alloc(0))
      }
    }
  }

  const signals = options.gracefulSignals === true ? {} : options.gracefulSignals || undefined
  const onSignal = (): void => {
    void stop(signals)
  }
  if (signals !== undefined) {
    process.once("SIGTERM", onSignal)
    process.once("SIGINT", onSignal)
  }

  let shutdown: Promise<void> | undefined
  const stop = (stopOptions: NodeStopOptions = {}): Promise<void> => {
    shutdown ??= stopOnce(stopOptions)
    return shutdown
  }
  const stopOnce = async ({
    drainMs = DEFAULT_DRAIN_MS,
    delayMs = 0,
  }: NodeStopOptions): Promise<void> => {
    if (closed) return
    closed = true
    if (signals !== undefined) {
      process.removeListener("SIGTERM", onSignal)
      process.removeListener("SIGINT", onSignal)
    }
    try {
      await lifecycle("stopping")
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
      uvServer.stopListening()
      for (const entry of [...wsSockets.values()]) entry.closeSocket(1001, "server shutting down")
      const deadline = Date.now() + drainMs
      while (
        (inflight.size > 0 || wsSockets.size > 0 || uvServer.hasUnsentOutput()) &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, DRAIN_POLL_MS))
      }
    } finally {
      uvServer.close()
      for (const reqId of inflight.keys()) abortRequest(reqId)
      for (const socketId of wsSockets.keys()) finishSocket(socketId, 1006, "")
    }
    await lifecycle("stopped")
  }

  const reloadTls = (tls: TlsOptions | undefined = currentTls): void => {
    if (closed) throw new Error("@nifrajs/node-engine: the server is not running")
    if (tls === undefined) {
      throw new Error("@nifrajs/node-engine: reloadTls requires a server started with `tls`")
    }
    uvServer.reloadTls(toRustTls(tls))
    currentTls = tls
  }

  return Promise.resolve({
    port: uvServer.port,
    stop,
    reloadTls,
    [Symbol.asyncDispose]: () => stop(),
  })
}
