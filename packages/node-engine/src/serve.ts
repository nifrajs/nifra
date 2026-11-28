/**
 * Serve a nifra app on Nifra's Rust engine (`nifra-napi`):
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
import { AsyncResource } from "node:async_hooks"
import { createPrivateKey, X509Certificate } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { createRequire, Module } from "node:module"
import { dirname, join, resolve } from "node:path"
import { Duplex } from "node:stream"
import { fileURLToPath } from "node:url"
import { serve as serveNode } from "@nifrajs/node"
import {
  activateAsyncContextFrame,
  createStaticResolver,
  enableNodeDirect,
  errorReporterOf,
  hostPolicyOf,
  installFastResponse,
  lifecycleOf,
  type NodeServeOutcome,
  type NodeStopOptions,
  nodeOutcomeRuntime,
  resolveRequestHost,
  resolveRequestTarget,
  type StaticRequestResolver,
} from "@nifrajs/node/transport"
import { declarativeRoutes, isServerView } from "./generated/declarative-routes.ts"
import { assertCloseArgs, exceedsPayloadCap } from "./generated/ws-close.ts"
import type { NifraWs, NifraWsData, WsUpgradeOutcome } from "./generated/ws-types.ts"
import {
  beginHttpDiagnostics,
  type HttpDiagnosticsHandle,
  hasHttpDiagnosticsSubscribers,
  SOURCE,
} from "./node-compat.ts"
import {
  bodyCeiling,
  type CompressionOptions,
  type EngineServer,
  type EngineSocket,
  type FetchHandler,
  type Http2Options,
  isCap,
  mayServeSockets,
  type PeerCertificateInfo,
  type ProbeResult,
  payloadCeiling,
  type ServeOptions,
  type TlsOptions,
  type TlsSniEntry,
  type WsDeflateOptions,
} from "./options.ts"

const INSTALL_NATIVE_PUBLISH = Symbol.for("@nifrajs/core/install-native-publish")

type WsUpgrade = Extract<WsUpgradeOutcome, { readonly kind: "upgrade" }>

const JSON_CONTENT_TYPE = Response.json(0).headers.get("content-type") ?? "application/json"
const INTERNAL_ERROR_BODY = '{"ok":false,"error":"internal_error"}'
const INTERNAL_ERROR_BUF = Buffer.from(INTERNAL_ERROR_BODY)

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
const FLAG_STREAM_BODY = 1 << 14

const DEFAULT_DRAIN_MS = 10_000
const DRAIN_POLL_MS = 10
const MAX_NATIVE_LENGTH = 0xffff_ffff
const MAX_CONTENT_LENGTH = Number.MAX_SAFE_INTEGER
const STREAM_BODY_HIGH_WATER = 256 * 1024
const STREAM_BODY_LOW_WATER = 128 * 1024
const DEFAULT_MAX_BODY_SIZE = 1_048_576
const MAX_BUFFERED_RESPONSE_BYTES = 2 * 1024 * 1024
const STREAM_CHUNK_BYTES = 256 * 1024
const CHUNK_FRAMING_HEADROOM = 64
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
const URL_DELIMITER = /[/\\?#@]/

type HeaderRecord = Readonly<Record<string, string | readonly string[]>>

interface RustBatchBuffers {
  readonly inMeta: Uint32Array
  readonly inData: Buffer
  readonly outMeta: Uint32Array
  readonly outData: Buffer
  readonly inSlotU32s: number
  readonly outSlotU32s: number
}

interface RustTlsSniEntry {
  readonly serverName: string
  readonly cert: string | undefined
  readonly key: string | undefined
  readonly certFileName: string | undefined
  readonly keyFileName: string | undefined
}

interface RustTlsOptions {
  readonly cert: string | undefined
  readonly key: string | undefined
  readonly certFileName: string | undefined
  readonly keyFileName: string | undefined
  readonly ca: string | undefined
  readonly caFileName: string | undefined
  readonly crl: string | undefined
  readonly crlFileName: string | undefined
  readonly requestCert: boolean | undefined
  readonly rejectUnauthorized: boolean | undefined
  readonly minVersion: string | undefined
  readonly maxVersion: string | undefined
  readonly ciphers: string | undefined
  readonly ciphersuites: string | undefined
  readonly ecdhCurve: string | undefined
  readonly serverNames: readonly RustTlsSniEntry[] | undefined
  readonly ticketKeys: Buffer | undefined
}

interface RustCompressionOptions {
  readonly enabled?: boolean
  readonly zstd?: boolean
  readonly brotli?: boolean
  readonly gzip?: boolean
  readonly deflate?: boolean
  readonly minBytes?: number
}

interface RustWsDeflateOptions {
  enabled?: boolean
  serverNoContextTakeover?: boolean
  clientNoContextTakeover?: boolean
  serverMaxWindowBits?: number
  clientMaxWindowBits?: number
  threshold?: number
  maxDecompressedSize?: number
  level?: number
  sharedCompressor?: boolean
}

interface RustUvServer {
  readonly port: number
  setStreamCallbacks(
    onWritable?: ((reqId: number) => void) | null,
    onAborted?: ((reqId: number) => void) | null,
  ): void
  setReqBodyCallback(
    onReqBody?: ((reqId: number, chunk: Buffer | null, isLast: boolean) => void) | null,
  ): void
  pauseRequestBody(reqId: number): boolean
  resumeRequestBody(reqId: number): boolean
  setWsCallbacks(
    onOpen?: ((socketId: number) => void) | null,
    onMessage?: ((socketId: number, data: string | ArrayBuffer) => void) | null,
    onClose?: ((socketId: number, code: number, reason: string) => void) | null,
    onDrain?: ((socketId: number) => void) | null,
  ): void
  upgradeToWebSocket(reqId: number, deflateOverride?: RustWsDeflateOptions | null): number
  wsSend(socketId: number, payload: Buffer, isBinary: boolean): boolean
  wsSendText(socketId: number, text: string): boolean
  wsClose(socketId: number, code: number, reason?: string | null): boolean
  wsGetHeaders(socketId: number): string[]
  wsGetQuery(socketId: number): string
  wsGetRemoteAddress(socketId: number): string | null
  wsGetPeerCertificates(socketId: number): Buffer[]
  wsGetBufferedAmount(socketId: number): number
  wsCorkBegin(socketId: number): boolean
  wsCorkEnd(socketId: number): boolean
  wsSubscribe(socketId: number, topic: string): boolean
  wsUnsubscribe(socketId: number, topic: string): boolean
  wsPublish(
    topic: string,
    payload: Buffer,
    isBinary: boolean,
    excludeSocketId?: number | null,
  ): number
  wsPublishText(topic: string, text: string, excludeSocketId?: number | null): number
  getBatchBuffers(): RustBatchBuffers
  getMethod(reqId: number): string | null
  getHeader(reqId: number, name: string): string | null
  getHeaders(reqId: number): string[]
  getTrailers(reqId: number): string[]
  setResponseTrailers(reqId: number, flatTrailers: string[]): boolean
  writeInformational(reqId: number, status: number, flatHeaders?: string[] | null): boolean
  getBody(reqId: number): Buffer<ArrayBuffer> | null
  getRemoteAddress(reqId: number): string | null
  getPeerCertificates(reqId: number): Buffer[]
  setConnectCallbacks(
    onData?: ((tunnelId: number, chunk: Buffer) => void) | null,
    onEnd?: ((tunnelId: number) => void) | null,
    onDrain?: ((tunnelId: number) => void) | null,
  ): void
  acceptConnect(
    reqId: number,
    status?: number | null,
    flatHeaders?: string[] | null,
  ): { readonly tunnelId: number; readonly head: Buffer } | null
  tunnelWrite(tunnelId: number, chunk: Buffer): number
  tunnelEnd(tunnelId: number): boolean
  tunnelDestroy(tunnelId: number): boolean
  tunnelPause(tunnelId: number): boolean
  tunnelResume(tunnelId: number): boolean
  setStaticRoute(path: string, status: number, flatHeaders: string[], body: Buffer): void
  setStaticPostRoute(path: string, status: number, flatHeaders: string[], body: Buffer): void
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
  addServerName(entry: RustTlsSniEntry): void
  removeServerName(serverName: string): boolean
  hasUnsentOutput(): boolean
  stopListening(): void
  close(): void
}

interface RustAddon {
  probe(): ProbeResult
  bindSharedListener?(
    host?: string | null,
    port?: number,
    backlog?: number | null,
  ): { readonly fd: number; readonly port: number }
  dupListenerFd?(fd: number): number
  createUvServer(
    host: string,
    port: number,
    onBatch: (count: number) => void,
    options?: {
      readonly maxBodySize?: number
      readonly oversizeWindow?: number
      readonly maxHeaderBytes?: number | undefined
      readonly maxHeaders?: number | undefined
      readonly maxUriSize?: number | undefined
      readonly maxPendingBytes?: number | undefined
      readonly idleTimeoutMs?: number | undefined
      readonly responseTimeoutMs?: number | undefined
      readonly responseBackpressureLimit?: number | undefined
      readonly backlog?: number | undefined
      readonly maxConnections?: number | undefined
      readonly requestTimeoutMs?: number | undefined
      readonly headersTimeoutMs?: number | undefined
      readonly wsMaxMessageSize?: number | undefined
      readonly wsMaxLifetimeMs?: number | undefined
      readonly wsMaxBackpressure?: number | undefined
      readonly wsCloseOnBackpressureLimit?: boolean | undefined
      readonly streamRequestBodies?: boolean | undefined
      readonly compression?: RustCompressionOptions | undefined
      readonly unixPath?: string | undefined
      readonly listenerFd?: number | undefined
      readonly wsDeflate?: RustWsDeflateOptions | undefined
      readonly http2?: boolean | undefined
      readonly http2MaxConcurrentStreams?: number | undefined
      readonly http2InitialWindowSize?: number | undefined
      readonly http2ConnectionWindowSize?: number | undefined
      readonly http2MaxFrameSize?: number | undefined
      readonly http2HeaderTableSize?: number | undefined
      readonly http2MaxSendBuffer?: number | undefined
      readonly http2PingIntervalMs?: number | undefined
      readonly http2PingTimeoutMs?: number | undefined
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

function pemBundleToString(
  value:
    | string
    | ArrayBuffer
    | Uint8Array
    | readonly (string | ArrayBuffer | Uint8Array)[]
    | undefined,
): string | undefined {
  if (value === undefined) return undefined
  if (Array.isArray(value)) {
    return value.map((item) => pemToString(item) ?? "").join("\n")
  }
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: narrowed non-array PEM union by Array.isArray
  return pemToString(value as string | ArrayBuffer | Uint8Array)
}

function toTicketBuffer(value: string | ArrayBuffer | Uint8Array | undefined): Buffer | undefined {
  if (value === undefined) return undefined
  if (typeof value === "string") return Buffer.from(value)
  if (Buffer.isBuffer(value)) return value
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value))
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
}

function decryptKeyIfNeeded(
  keyPem: string | undefined,
  keyFileName: string | undefined,
  passphrase: string | undefined,
): { readonly key: string | undefined; readonly keyFileName: string | undefined } {
  if (passphrase === undefined) return { key: keyPem, keyFileName }
  if (typeof passphrase !== "string") {
    throw new TypeError("@nifrajs/node-engine: `tls.passphrase` must be a string")
  }
  const sourcePem =
    keyPem ?? (keyFileName === undefined ? undefined : readFileSync(keyFileName, "utf8"))
  if (sourcePem === undefined) return { key: undefined, keyFileName }
  const exported = createPrivateKey({
    key: sourcePem,
    format: "pem",
    passphrase,
  }).export({ format: "pem", type: "pkcs8" })
  return { key: exported, keyFileName: undefined }
}

function toRustTlsSni(entry: TlsSniEntry): RustTlsSniEntry {
  if (typeof entry.serverName !== "string" || entry.serverName.length === 0) {
    throw new TypeError("@nifrajs/node-engine: `tls.serverNames[].serverName` must be non-empty")
  }
  const cert = pemToString(entry.cert)
  const rawKey = pemToString(entry.key)
  const { key, keyFileName } = decryptKeyIfNeeded(rawKey, entry.key_file_name, entry.passphrase)
  return {
    serverName: entry.serverName,
    cert,
    key,
    certFileName: entry.cert_file_name,
    keyFileName,
  }
}

function toRustTls(tls: TlsOptions): RustTlsOptions {
  if (tls.requestCert !== undefined && typeof tls.requestCert !== "boolean") {
    throw new TypeError("@nifrajs/node-engine: `tls.requestCert` must be a boolean")
  }
  if (tls.rejectUnauthorized !== undefined && typeof tls.rejectUnauthorized !== "boolean") {
    throw new TypeError("@nifrajs/node-engine: `tls.rejectUnauthorized` must be a boolean")
  }
  if (
    tls.minVersion !== undefined &&
    tls.minVersion !== "TLSv1.2" &&
    tls.minVersion !== "TLSv1.3"
  ) {
    throw new TypeError('@nifrajs/node-engine: `tls.minVersion` must be "TLSv1.2" or "TLSv1.3"')
  }
  if (
    tls.maxVersion !== undefined &&
    tls.maxVersion !== "TLSv1.2" &&
    tls.maxVersion !== "TLSv1.3"
  ) {
    throw new TypeError('@nifrajs/node-engine: `tls.maxVersion` must be "TLSv1.2" or "TLSv1.3"')
  }
  if (tls.ciphers !== undefined && typeof tls.ciphers !== "string") {
    throw new TypeError("@nifrajs/node-engine: `tls.ciphers` must be a string")
  }
  if (tls.ciphersuites !== undefined && typeof tls.ciphersuites !== "string") {
    throw new TypeError("@nifrajs/node-engine: `tls.ciphersuites` must be a string")
  }
  if (tls.ecdhCurve !== undefined && typeof tls.ecdhCurve !== "string") {
    throw new TypeError("@nifrajs/node-engine: `tls.ecdhCurve` must be a string")
  }
  if (tls.serverNames !== undefined && !Array.isArray(tls.serverNames)) {
    throw new TypeError("@nifrajs/node-engine: `tls.serverNames` must be an array")
  }
  const cert = pemToString(tls.cert)
  const rawKey = pemToString(tls.key)
  const { key, keyFileName } = decryptKeyIfNeeded(rawKey, tls.key_file_name, tls.passphrase)
  const ca = pemBundleToString(tls.ca)
  const crl = pemBundleToString(tls.crl)
  const serverNames = tls.serverNames?.map(toRustTlsSni)
  const ticketKeys = toTicketBuffer(tls.ticketKeys)
  return {
    cert,
    key,
    certFileName: tls.cert_file_name,
    keyFileName,
    ca,
    caFileName: tls.ca_file_name,
    crl,
    crlFileName: tls.crl_file_name,
    requestCert: tls.requestCert,
    rejectUnauthorized: tls.rejectUnauthorized,
    minVersion: tls.minVersion,
    maxVersion: tls.maxVersion,
    ciphers: tls.ciphers,
    ciphersuites: tls.ciphersuites,
    ecdhCurve: tls.ecdhCurve,
    serverNames,
    ticketKeys,
  }
}

function toRustCompression(
  opt: boolean | CompressionOptions | undefined,
): RustCompressionOptions | undefined {
  if (opt === undefined || opt === false) return undefined
  if (opt === true) return { enabled: true }
  if (typeof opt !== "object" || opt === null) {
    throw new TypeError("@nifrajs/node-engine: `compression` must be a boolean or options object")
  }
  const out: {
    enabled?: boolean
    zstd?: boolean
    brotli?: boolean
    gzip?: boolean
    deflate?: boolean
    minBytes?: number
  } = { enabled: opt.enabled ?? true }
  if (opt.zstd !== undefined) {
    if (typeof opt.zstd !== "boolean") {
      throw new TypeError("@nifrajs/node-engine: `compression.zstd` must be a boolean")
    }
    out.zstd = opt.zstd
  }
  if (opt.brotli !== undefined) {
    if (typeof opt.brotli !== "boolean") {
      throw new TypeError("@nifrajs/node-engine: `compression.brotli` must be a boolean")
    }
    out.brotli = opt.brotli
  }
  if (opt.gzip !== undefined) {
    if (typeof opt.gzip !== "boolean") {
      throw new TypeError("@nifrajs/node-engine: `compression.gzip` must be a boolean")
    }
    out.gzip = opt.gzip
  }
  if (opt.deflate !== undefined) {
    if (typeof opt.deflate !== "boolean") {
      throw new TypeError("@nifrajs/node-engine: `compression.deflate` must be a boolean")
    }
    out.deflate = opt.deflate
  }
  if (opt.minBytes !== undefined) {
    if (
      typeof opt.minBytes !== "number" ||
      !Number.isSafeInteger(opt.minBytes) ||
      opt.minBytes < 0 ||
      opt.minBytes > MAX_NATIVE_LENGTH
    ) {
      throw new TypeError(
        "@nifrajs/node-engine: `compression.minBytes` must be a non-negative integer below 2^32",
      )
    }
    out.minBytes = opt.minBytes
  }
  return out
}

function toRustWsDeflate(
  opt: boolean | WsDeflateOptions | undefined,
): RustWsDeflateOptions | undefined {
  if (opt === undefined || opt === false) return undefined
  if (opt === true) return {}
  if (typeof opt !== "object" || opt === null) {
    throw new TypeError("@nifrajs/node-engine: `wsDeflate` must be a boolean or options object")
  }
  const out: RustWsDeflateOptions = {}
  if (opt.serverNoContextTakeover !== undefined) {
    if (typeof opt.serverNoContextTakeover !== "boolean") {
      throw new TypeError(
        "@nifrajs/node-engine: `wsDeflate.serverNoContextTakeover` must be a boolean",
      )
    }
    out.serverNoContextTakeover = opt.serverNoContextTakeover
  }
  if (opt.clientNoContextTakeover !== undefined) {
    if (typeof opt.clientNoContextTakeover !== "boolean") {
      throw new TypeError(
        "@nifrajs/node-engine: `wsDeflate.clientNoContextTakeover` must be a boolean",
      )
    }
    out.clientNoContextTakeover = opt.clientNoContextTakeover
  }
  if (opt.serverMaxWindowBits !== undefined) {
    if (
      typeof opt.serverMaxWindowBits !== "number" ||
      !Number.isInteger(opt.serverMaxWindowBits) ||
      opt.serverMaxWindowBits < 9 ||
      opt.serverMaxWindowBits > 15
    ) {
      throw new TypeError(
        "@nifrajs/node-engine: `wsDeflate.serverMaxWindowBits` must be an integer 9..15",
      )
    }
    out.serverMaxWindowBits = opt.serverMaxWindowBits
  }
  if (opt.clientMaxWindowBits !== undefined) {
    if (
      typeof opt.clientMaxWindowBits !== "number" ||
      !Number.isInteger(opt.clientMaxWindowBits) ||
      opt.clientMaxWindowBits < 8 ||
      opt.clientMaxWindowBits > 15
    ) {
      throw new TypeError(
        "@nifrajs/node-engine: `wsDeflate.clientMaxWindowBits` must be an integer 8..15",
      )
    }
    out.clientMaxWindowBits = opt.clientMaxWindowBits
  }
  if (opt.threshold !== undefined) {
    if (
      typeof opt.threshold !== "number" ||
      !Number.isSafeInteger(opt.threshold) ||
      opt.threshold < 0 ||
      opt.threshold > MAX_NATIVE_LENGTH
    ) {
      throw new TypeError(
        "@nifrajs/node-engine: `wsDeflate.threshold` must be a non-negative integer below 2^32",
      )
    }
    out.threshold = opt.threshold
  }
  if (opt.maxDecompressedSize !== undefined) {
    if (!(isCap(opt.maxDecompressedSize) && opt.maxDecompressedSize <= MAX_NATIVE_LENGTH)) {
      throw new TypeError(
        "@nifrajs/node-engine: `wsDeflate.maxDecompressedSize` must be a positive integer below 2^32",
      )
    }
    out.maxDecompressedSize = opt.maxDecompressedSize
  }
  if (opt.level !== undefined) {
    if (
      typeof opt.level !== "number" ||
      !Number.isInteger(opt.level) ||
      opt.level < 1 ||
      opt.level > 9
    ) {
      throw new TypeError("@nifrajs/node-engine: `wsDeflate.level` must be an integer 1..9")
    }
    out.level = opt.level
  }
  if (opt.sharedCompressor !== undefined) {
    if (typeof opt.sharedCompressor !== "boolean") {
      throw new TypeError("@nifrajs/node-engine: `wsDeflate.sharedCompressor` must be a boolean")
    }
    out.sharedCompressor = opt.sharedCompressor
  }
  return out
}

function optionalPositiveCap(name: string, value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!(isCap(value) && value <= MAX_NATIVE_LENGTH)) {
    throw new TypeError(
      `@nifrajs/node-engine: \`engine.${name}\` must be a positive integer below 2^32`,
    )
  }
  return value
}

function optionalNonNegCap(name: string, value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_NATIVE_LENGTH
  ) {
    throw new TypeError(
      `@nifrajs/node-engine: \`engine.${name}\` must be a non-negative integer below 2^32`,
    )
  }
  return value
}

function optionalNonNegMs(name: string, value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(
      `@nifrajs/node-engine: \`engine.${name}\` must be a non-negative finite number`,
    )
  }
  return Math.min(Math.round(value), MAX_NATIVE_LENGTH)
}

function toRustHttp2(options: Http2Options) {
  const bounded = (name: keyof Http2Options, min: number, max: number): number | undefined => {
    const value = options[name]
    if (value === undefined) return undefined
    if (!(Number.isInteger(value) && value >= min && value <= max)) {
      throw new TypeError(
        `@nifrajs/node-engine: \`http2.${name}\` must be an integer from ${min} to ${max}`,
      )
    }
    return value
  }
  return {
    http2MaxConcurrentStreams: options.maxConcurrentStreams,
    http2InitialWindowSize: bounded("initialWindowSize", 1, 0x7fff_ffff),
    http2ConnectionWindowSize: bounded("connectionWindowSize", 65_535, 0x7fff_ffff),
    http2MaxFrameSize: bounded("maxFrameSize", 16_384, 16_777_215),
    http2HeaderTableSize: bounded("headerTableSize", 0, 65_536),
    http2MaxSendBuffer: bounded("maxSendBuffer", 1, MAX_NATIVE_LENGTH),
    http2PingIntervalMs: bounded("pingIntervalMs", 0, MAX_NATIVE_LENGTH),
    http2PingTimeoutMs: bounded("pingTimeoutMs", 1, MAX_NATIVE_LENGTH),
  }
}

let cachedAddon: RustAddon | undefined
let cachedAddonKey: string | undefined

function linuxLibcSuffix(): string {
  if (process.platform !== "linux") return ""
  try {
    const report = process.report?.getReport()
    if (typeof report === "object" && report !== null && "header" in report) {
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: narrowed Node diagnostic report object
      const header = (report as { readonly header?: { readonly glibcVersionRuntime?: string } })
        .header
      if (header?.glibcVersionRuntime !== undefined) return "-gnu"
    }
  } catch {
    // ignore report unavailability
  }
  return existsSync("/lib/ld-musl-x86_64.so.1") || existsSync("/lib/ld-musl-aarch64.so.1")
    ? "-musl"
    : "-gnu"
}

function resolvePrebuiltAddon(engineRoot: string): string | undefined {
  const libc = linuxLibcSuffix()
  const pkgTags =
    libc.length > 0
      ? [`${process.platform}-${process.arch}${libc}`, `${process.platform}-${process.arch}`]
      : [`${process.platform}-${process.arch}`]
  const req = createRequire(import.meta.url)
  for (const tag of pkgTags) {
    try {
      const resolved = req.resolve(`@nifrajs/node-engine-${tag}/nifra_napi.node`)
      if (existsSync(resolved)) return resolved
    } catch {
      // optional prebuilt package not installed
    }
  }
  const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
  for (const tag of pkgTags) {
    const localPrebuild = join(pkgRoot, "prebuilds", tag, "nifra_napi.node")
    if (existsSync(localPrebuild)) return localPrebuild
  }
  const library =
    process.platform === "win32"
      ? "nifra_napi.dll"
      : process.platform === "darwin"
        ? "libnifra_napi.dylib"
        : "libnifra_napi.so"
  return [`target/release/${library}`, `target/debug/${library}`, "nifra_napi.node"]
    .map((name) => join(engineRoot, name))
    .find(existsSync)
}

function loadRustAddon(): RustAddon {
  const explicit = process.env.NIFRA_RUST_ENGINE_PATH
  const here = dirname(fileURLToPath(import.meta.url))
  const engineRoot = resolve(here, "../../../native/nifra-engine")
  const binary = explicit === undefined ? resolvePrebuiltAddon(engineRoot) : resolve(explicit)
  if (binary === undefined || !existsSync(binary)) {
    throw new TypeError(
      `@nifrajs/node-engine: a native addon is required at ${binary ?? engineRoot}. Run \`cargo build --release -p nifra-napi\` in native/nifra-engine or set NIFRA_RUST_ENGINE_PATH.`,
    )
  }
  if (cachedAddon !== undefined && cachedAddonKey === binary) return cachedAddon
  const addon = new Module(binary)
  // Cargo uses the platform's shared library extension. Load it in place.
  process.dlopen(addon, binary)
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: native NAPI-RS addon conforms to RustAddon
  cachedAddon = addon.exports as RustAddon
  cachedAddonKey = binary
  return cachedAddon
}

/** Probe whether a native addon binary is available on this host and report its transport/capabilities. */
export function probe(): ProbeResult {
  try {
    return loadRustAddon().probe()
  } catch (error) {
    return {
      ok: false,
      version: "0.0.0",
      platform: process.platform,
      arch: process.arch,
      transport: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
      capabilities: {},
    }
  }
}

/** Whether the native Rust engine addon can be loaded in this process. */
export function isNativeAvailable(): boolean {
  return probe().ok
}

/** Bind a passive primary listener socket without starting a libuv accept loop in the primary. */
export function bindSharedListenerSocket(
  port: number,
  host: string | undefined,
  backlog: number | undefined,
): { readonly fd: number; readonly port: number } | undefined {
  try {
    return loadRustAddon().bindSharedListener?.(host ?? "127.0.0.1", port, backlog ?? null)
  } catch {
    return undefined
  }
}

/** Duplicate a received IPC listener descriptor so the IPC wrapper socket can close immediately. */
export function dupSharedListenerFd(fd: number): number | undefined {
  try {
    return loadRustAddon().dupListenerFd?.(fd)
  } catch {
    return undefined
  }
}

const isBodyless = (status: number): boolean => status === 204 || status === 205 || status === 304

function ownedHeader(name: string): boolean {
  const lower = name.toLowerCase()
  return lower === "date" || lower === "content-length" || lower === "transfer-encoding"
}

function validateAndBuildFlatHeaders(
  status: number,
  headers: HeaderRecord | undefined,
  cookies: readonly string[] | undefined,
  defaultType: string | undefined,
): string[] {
  if (!Number.isInteger(status) || status < 100 || status > 999) {
    throw new RangeError(`Invalid status code: ${String(status)}`)
  }
  const flat: string[] = []
  let typed = false
  if (headers !== undefined) {
    for (const name in headers) {
      if (!Object.hasOwn(headers, name)) continue
      if (!TOKEN.test(name)) throw new TypeError("Invalid character in header name")
      const value = headers[name]
      const skip = ownedHeader(name)
      if (!skip && !typed && name.length === 12 && name.toLowerCase() === "content-type") {
        typed = true
      }
      if (typeof value === "string") {
        if (BAD_VALUE.test(value)) throw new TypeError("Invalid character in header content")
        if (!skip) flat.push(name, value)
      } else if (value !== undefined) {
        for (const each of value) {
          if (BAD_VALUE.test(each)) throw new TypeError("Invalid character in header content")
          if (!skip) flat.push(name, each)
        }
      }
    }
  }
  if (!typed && defaultType !== undefined) flat.push("content-type", defaultType)
  if (cookies !== undefined) {
    for (const cookie of cookies) {
      if (BAD_VALUE.test(cookie)) throw new TypeError("Invalid character in header content")
      flat.push("set-cookie", cookie)
    }
  }
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

const checkedNames = new Set<string>()

/**
 * The header lines of a batched response, under the rules of `validateAndBuildFlatHeaders`.
 * `undefined` when one cannot be written: the unbatched writer then refuses it and answers.
 */
function headerBlock(
  headers: HeaderRecord | undefined,
  cookies: readonly string[] | undefined,
  defaultType: string | undefined,
): string | undefined {
  let block = ""
  let typed = false
  if (headers !== undefined) {
    for (const name in headers) {
      if (!Object.hasOwn(headers, name)) continue
      if (!checkedNames.has(name)) {
        if (!TOKEN.test(name)) return undefined
        if (checkedNames.size >= 512) checkedNames.clear()
        checkedNames.add(name)
      }
      const value = headers[name]
      const skip = ownedHeader(name)
      if (!skip && !typed && name.length === 12 && name.toLowerCase() === "content-type") {
        typed = true
      }
      if (typeof value === "string") {
        if (BAD_VALUE.test(value)) return undefined
        if (!skip) block += `${name}: ${value}\r\n`
      } else if (value !== undefined) {
        for (const each of value) {
          if (BAD_VALUE.test(each)) return undefined
          if (!skip) block += `${name}: ${each}\r\n`
        }
      }
    }
  }
  if (!typed && defaultType !== undefined) block += `content-type: ${defaultType}\r\n`
  if (cookies !== undefined) {
    for (const cookie of cookies) {
      if (BAD_VALUE.test(cookie)) return undefined
      block += `set-cookie: ${cookie}\r\n`
    }
  }
  return block
}

const NO_BODY_BYTES = new Uint8Array(0)

function declaredContentLength(headers: HeaderRecord | undefined): number | undefined {
  if (headers === undefined) return undefined
  for (const [name, value] of Object.entries(headers)) {
    if (name.length !== 14 || name.toLowerCase() !== "content-length") continue
    const text = typeof value === "string" ? value : value?.[0]
    if (text === undefined || !/^\d{1,20}$/.test(text)) return undefined
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

interface ReqBodyStreamState {
  controller?: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>> | undefined
  readonly queue: Uint8Array<ArrayBuffer>[]
  queuedBytes: number
  paused: boolean
  ended: boolean
  cancelled: boolean
  stream?: ReadableStream<Uint8Array<ArrayBuffer>> | undefined
  waiters: Array<(done: boolean, error?: Error) => void>
}

function terminateReqBodyStream(state: ReqBodyStreamState, err: Error): void {
  state.ended = true
  state.cancelled = true
  state.queue.length = 0
  state.queuedBytes = 0
  if (state.controller !== undefined) {
    try {
      state.controller.error(err)
    } catch {
      // already errored or closed
    }
  }
  const waiters = state.waiters.splice(0, state.waiters.length)
  for (const wake of waiters) wake(true, err)
}

type SourcedRequest = Request & { [SOURCE]?: RustBatchSource }

const FORBIDDEN_FETCH_METHODS = new Set(["CONNECT", "TRACE", "TRACK"])
const EMPTY_UINT8 = new Uint8Array(0)

/**
 * Node's Fetch `new Request(url, { method })` throws on `TRACE`/`CONNECT`/`TRACK` per the Fetch
 * spec, even though raw HTTP servers (`node:http`, `Bun.serve`) deliver them into handlers.
 * Prototype-chaining onto `Request.prototype` preserves `instanceof Request` and standard getters
 * so plain `{ fetch }` handlers can answer `TRACE` (etc.) without a forced 500.
 */
const RawMethodRequest = /* @__PURE__ */ (() => {
  const NativeRequest = globalThis.Request
  class RawMethodRequest implements Request {
    readonly method: string
    readonly url: string
    readonly headers: Headers
    readonly signal: AbortSignal
    readonly cache: Request["cache"] = "default"
    readonly credentials: Request["credentials"] = "same-origin"
    readonly destination: Request["destination"] = ""
    readonly integrity = ""
    readonly keepalive = false
    readonly mode: Request["mode"] = "cors"
    readonly redirect: Request["redirect"] = "follow"
    readonly referrer = "about:client"
    readonly referrerPolicy: Request["referrerPolicy"] = ""
    readonly duplex = "half" as const
    declare readonly textStream: Request["textStream"]
    private bodyConsumed = false
    private bodyValue: Request["body"]
    private readonly readerSource: RustBatchSource

    constructor(source: RustBatchSource, signal: AbortSignal, body: Request["body"]) {
      this.readerSource = source
      this.method = source.method
      this.url = source.url
      this.headers = source.headers
      this.signal = signal
      this.bodyValue = body
    }

    get body(): Request["body"] {
      return this.bodyValue
    }

    get bodyUsed(): boolean {
      return this.bodyConsumed || (this.bodyValue?.locked ?? false)
    }

    private consume(): void {
      if (this.bodyConsumed) throw new TypeError("Body already used")
      this.bodyConsumed = true
    }

    arrayBuffer(): Promise<ArrayBuffer> {
      this.consume()
      return this.readerSource.arrayBuffer()
    }

    bytes(): Promise<Uint8Array<ArrayBuffer>> {
      this.consume()
      return this.readerSource.bytes()
    }

    text(): Promise<string> {
      this.consume()
      return this.readerSource
        .bytes()
        .then((b) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("utf8"))
    }

    json(): Promise<unknown> {
      this.consume()
      return this.readerSource.json()
    }

    blob(): Promise<Blob> {
      this.consume()
      const type = this.headers.get("content-type") ?? ""
      return this.readerSource.bytes().then((b) => new Blob([Uint8Array.from(b)], { type }))
    }

    formData(): ReturnType<Request["formData"]> {
      this.consume()
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: undici FormData type in global vs undici-types overlaps identically at runtime
      return new Response(this.bodyValue ?? EMPTY_UINT8, {
        headers: this.headers,
      }).formData() as ReturnType<Request["formData"]>
    }

    clone(): Request {
      if (this.bodyUsed) throw new TypeError("Request body is already used")
      const nextBody = this.bodyValue === null ? null : this.bodyValue.tee()[1]
      return new RawMethodRequest(this.readerSource, this.signal, nextBody)
    }
  }
  Object.setPrototypeOf(RawMethodRequest.prototype, NativeRequest.prototype)
  return RawMethodRequest
})()

/**
 * HTTP/2 only: set the fields the response to `request` ends with, replacing any set before. Call it
 * before the body ends, with the `Request` the engine made (`c.req` in a nifra route), not a copy.
 * `false`, and nothing is set, on HTTP/1.1, once the response is complete, or when a name or value
 * cannot be a trailer.
 */
export function setResponseTrailers(
  request: Request,
  trailers: Readonly<Record<string, string>>,
): boolean {
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the tag is optional, so an untagged Request reads as undefined
  return (request as SourcedRequest)[SOURCE]?.setTrailers(trailers) ?? false
}

/**
 * Send an HTTP `1xx` informational response (such as `103 Early Hints`) before the final response
 * is sent for `request`. Supports HTTP/1.1 (including pipelining) and HTTP/2.
 */
export function writeInformational(
  request: Request,
  status: number,
  headers: Readonly<Record<string, string | readonly string[]>> = {},
): boolean {
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the tag is optional, so an untagged Request reads as undefined
  return (request as SourcedRequest)[SOURCE]?.writeInformational(status, headers) ?? false
}

/**
 * Send a `103 Early Hints` informational response before the final response for `request`.
 */
export function writeEarlyHints(
  request: Request,
  hints: Readonly<Record<string, string | readonly string[]>>,
): boolean {
  return writeInformational(request, 103, hints)
}

function buildPeerCertificate(
  derChain: readonly Buffer[],
  detailed: boolean,
  index = 0,
): PeerCertificateInfo | null {
  const der = derChain[index]
  if (der === undefined) return null
  const x509 = new X509Certificate(der)
  const next = detailed ? buildPeerCertificate(derChain, true, index + 1) : null
  const info: PeerCertificateInfo = {
    subject: x509.subject,
    issuer: x509.issuer,
    subjectAltName: x509.subjectAltName,
    validFrom: x509.validFrom,
    validTo: x509.validTo,
    serialNumber: x509.serialNumber,
    fingerprint: x509.fingerprint,
    fingerprint256: x509.fingerprint256,
    fingerprint512: x509.fingerprint512,
    raw: x509.raw,
    x509,
  }
  return next === null ? info : { ...info, issuerCertificate: next }
}

/**
 * Return the client certificate presented on an mTLS connection for `request`, or `null` when
 * the request did not arrive over TLS with a client certificate.
 */
export function getPeerCertificate(request: Request, detailed = false): PeerCertificateInfo | null {
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the tag is optional, so an untagged Request reads as undefined
  return (request as SourcedRequest)[SOURCE]?.getPeerCertificate(detailed) ?? null
}

/** Request view backed by the zero-copy `inData` slice with lazy FFI fallback for headers/bodies. */
class RustBatchSource {
  readonly method: string
  readonly urlParts: { readonly pathname: string; readonly search: string }
  aborted = false
  settled = false
  headWritten = false
  responseStatus = 200
  diag: HttpDiagnosticsHandle | undefined
  asyncScope: AsyncResource | undefined
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
  private bodyBytes: Uint8Array<ArrayBuffer> | null | undefined
  private streamState: ReqBodyStreamState | undefined
  /** The request's first `Content-Type`: `null` when it had none, `undefined` when not carried (ask the engine). */
  private readonly contentType: string | null | undefined
  private peer: string | undefined
  private peerCertChain: readonly Buffer[] | undefined
  private urlValue: string | undefined
  private headersValue: Headers | undefined
  private trailersValue: Record<string, string> | undefined
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
    bodyBytes: Uint8Array<ArrayBuffer> | null | undefined,
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
    if ((flags & FLAG_STREAM_BODY) !== 0) {
      this.streamState = {
        queue: [],
        queuedBytes: 0,
        paused: false,
        ended: false,
        cancelled: false,
        waiters: [],
      }
    }
  }

  get requestId(): number {
    return this.id
  }

  get isH2(): boolean {
    return (this.flags & FLAG_IS_H2) !== 0
  }

  get isStreamingBody(): boolean {
    return this.streamState !== undefined
  }

  pushBodyChunk(chunk: Buffer | null, isLast: boolean): void {
    const state = this.streamState
    if (state === undefined || state.ended || state.cancelled) return
    if (chunk !== null && chunk.byteLength > 0) {
      const copy = new Uint8Array(chunk.byteLength)
      copy.set(chunk)
      if (state.controller !== undefined) {
        state.controller.enqueue(copy)
        if ((state.controller.desiredSize ?? 1) <= 0 && !state.paused && this.id >= 0) {
          state.paused = true
          this.server.pauseRequestBody(this.id)
        }
      } else {
        state.queue.push(copy)
        state.queuedBytes += copy.byteLength
        if (state.queuedBytes >= STREAM_BODY_HIGH_WATER && !state.paused && this.id >= 0) {
          state.paused = true
          this.server.pauseRequestBody(this.id)
        }
      }
    }
    if (isLast) {
      state.ended = true
      if (state.controller !== undefined) {
        state.controller.close()
      }
    }
    if (state.waiters.length > 0 && (state.queue.length > 0 || state.ended)) {
      const waiters = state.waiters.splice(0, state.waiters.length)
      for (const wake of waiters) wake(state.ended)
    }
  }

  release(): void {
    const reqId = this.id
    this.id = -1
    const state = this.streamState
    if (state !== undefined && !state.ended) {
      if (state.paused && reqId >= 0) {
        state.paused = false
        this.server.resumeRequestBody(reqId)
      }
      terminateReqBodyStream(state, new Error("Request stream released"))
    }
  }

  abort(): void {
    if (this.aborted) return
    this.aborted = true
    const state = this.streamState
    if (state !== undefined && !state.ended) {
      terminateReqBodyStream(state, new Error("Request aborted"))
    }
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

  getPeerCertificate(detailed = false): PeerCertificateInfo | null {
    if (this.peerCertChain === undefined && this.id >= 0) {
      this.peerCertChain = this.server.getPeerCertificates(this.id)
    }
    return this.peerCertChain === undefined
      ? null
      : buildPeerCertificate(this.peerCertChain, detailed)
  }

  get url(): string {
    if (this.urlValue === undefined) {
      if (this.method === "CONNECT") {
        const target =
          this.target === "/"
            ? (this.authority ??
              (this.id >= 0 ? this.server.getHeader(this.id, "host") : null) ??
              "localhost")
            : this.target
        this.urlValue = `${this.protocol}://${target}`
      } else {
        const host =
          this.authority ??
          (this.id >= 0 ? this.server.getHeader(this.id, "host") : null) ??
          "localhost"
        this.urlValue = `${this.protocol}://${host}${this.target}`
      }
    }
    return this.urlValue
  }

  header(name: string): string | null {
    const lower =
      name === "content-type" || name === "content-length" || name === "transfer-encoding"
        ? name
        : name.toLowerCase()
    if (lower === "content-type" && this.contentType !== undefined) return this.contentType
    if (lower === "transfer-encoding") {
      return (this.flags & FLAG_CHUNKED) !== 0 ? "chunked" : null
    }
    if (lower === "content-length" && (this.flags & FLAG_CHUNKED) === 0) {
      if ((this.flags & FLAG_STREAM_BODY) !== 0) {
        return this.id >= 0 ? this.server.getHeader(this.id, "content-length") : null
      }
      if ((this.flags & FLAG_HAS_BODY) !== 0) {
        return String(this.bodyLen)
      }
    }
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

  get trailers(): Record<string, string> {
    if (this.trailersValue === undefined) {
      const pairs = this.id < 0 ? [] : this.server.getTrailers(this.id)
      const out: Record<string, string> = Object.create(null)
      for (let i = 0; i < pairs.length; i += 2) {
        const name = pairs[i] ?? ""
        const val = pairs[i + 1] ?? ""
        if (name.length > 0) {
          out[name] = Object.hasOwn(out, name) ? `${out[name]}, ${val}` : val
        }
      }
      const streamingPending = (this.flags & FLAG_STREAM_BODY) !== 0 && !this.streamState?.ended
      if (streamingPending) return out
      this.trailersValue = out
    }
    return this.trailersValue
  }

  setTrailers(trailers: Readonly<Record<string, string>>): boolean {
    if (this.id < 0 || !this.isH2) return false
    return this.server.setResponseTrailers(this.id, Object.entries(trailers).flat())
  }

  writeInformational(
    status: number,
    headers: Readonly<Record<string, string | readonly string[]>>,
  ): boolean {
    if (this.id < 0 || this.aborted || this.settled || this.headWritten) return false
    if (!Number.isInteger(status) || status < 100 || status > 199 || status === 101) return false
    const flat: string[] = []
    for (const [name, value] of Object.entries(headers)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          flat.push(name, String(item))
        }
      } else {
        flat.push(name, String(value))
      }
    }
    return this.server.writeInformational(this.id, status, flat)
  }

  private toBytes(): Uint8Array<ArrayBuffer> | null {
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

  private async drainStreamBytes(): Promise<Uint8Array> {
    const state = this.streamState
    if (state === undefined) return this.toBytes() ?? NO_BODY_BYTES
    const parts: Uint8Array[] = []
    for (;;) {
      while (state.queue.length > 0) {
        const chunk = state.queue.shift()
        if (chunk !== undefined) {
          state.queuedBytes -= chunk.byteLength
          parts.push(chunk)
        }
      }
      if (state.paused && state.queuedBytes < STREAM_BODY_LOW_WATER && this.id >= 0) {
        state.paused = false
        this.server.resumeRequestBody(this.id)
      }
      if (state.ended) break
      await new Promise<void>((resolveWait, rejectWait) => {
        state.waiters.push((_done, err) => {
          if (err !== undefined) rejectWait(err)
          else resolveWait()
        })
      })
    }
    return parts.length === 1 ? (parts[0] ?? NO_BODY_BYTES) : Buffer.concat(parts)
  }

  get body(): Request["body"] {
    const state = this.streamState
    if (state !== undefined) {
      if (state.stream !== undefined) return state.stream
      const source = this
      state.stream = new ReadableStream<Uint8Array<ArrayBuffer>>(
        {
          start(controller) {
            state.controller = controller
            while (state.queue.length > 0) {
              const chunk = state.queue.shift()
              if (chunk !== undefined) {
                state.queuedBytes -= chunk.byteLength
                controller.enqueue(chunk)
              }
            }
            if (state.ended) {
              controller.close()
            } else if (
              state.paused &&
              state.queuedBytes < STREAM_BODY_LOW_WATER &&
              source.id >= 0
            ) {
              state.paused = false
              source.server.resumeRequestBody(source.id)
            }
          },
          pull() {
            if (state.paused && source.id >= 0) {
              state.paused = false
              source.server.resumeRequestBody(source.id)
            }
          },
          cancel() {
            state.cancelled = true
            state.ended = true
            state.queue.length = 0
            state.queuedBytes = 0
            if (source.id >= 0) source.server.abortStream(source.id)
          },
        },
        {
          highWaterMark: STREAM_BODY_HIGH_WATER,
          size: (chunk) => chunk?.byteLength ?? 0,
        },
      )
      return state.stream
    }
    const bytes = this.toBytes()
    if (bytes === null) return null
    return new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        if (bytes.byteLength > 0) controller.enqueue(bytes)
        controller.close()
      },
    })
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    if (this.streamState !== undefined) {
      return this.drainStreamBytes().then((bytes) => {
        const copy = new Uint8Array(bytes.byteLength)
        copy.set(bytes)
        return copy.buffer
      })
    }
    const bytes = this.toBytes()
    if (bytes === null) return Promise.resolve(NO_BODY)
    // Exactly the body's bytes: `bytes` may be a view into a pooled Buffer.
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes)
    return Promise.resolve(copy.buffer)
  }

  bytes(): Promise<Uint8Array<ArrayBuffer>> {
    if (this.streamState !== undefined) {
      return this.drainStreamBytes().then((bytes) => new Uint8Array(bytes))
    }
    // A copy, as `arrayBuffer()`: the view's `.buffer` would expose the rest of a pooled Buffer.
    return Promise.resolve(new Uint8Array(this.toBytes() ?? NO_BODY_BYTES))
  }

  jsonNow(): { readonly value: unknown; readonly byteLength: number } | undefined {
    if (this.streamState !== undefined) return undefined
    if (this.bodyText !== null) {
      return { value: JSON.parse(this.bodyText), byteLength: this.bodyText.length }
    }
    const bytes = this.toBytes()
    if (bytes === null) return { value: JSON.parse(""), byteLength: 0 }
    return { value: parseJsonBytes(bytes), byteLength: bytes.byteLength }
  }

  json(): Promise<unknown> {
    if (this.streamState !== undefined) {
      return this.drainStreamBytes().then((bytes) => parseJsonBytes(bytes))
    }
    try {
      const now = this.jsonNow()
      return Promise.resolve(now === undefined ? undefined : now.value)
    } catch (error) {
      return Promise.reject(error)
    }
  }

  jsonWithByteLength(): Promise<{ readonly value: unknown; readonly byteLength: number }> {
    if (this.streamState !== undefined) {
      return this.drainStreamBytes().then((bytes) => ({
        value: parseJsonBytes(bytes),
        byteLength: bytes.byteLength,
      }))
    }
    try {
      const now = this.jsonNow()
      if (now === undefined) {
        return this.drainStreamBytes().then((bytes) => ({
          value: parseJsonBytes(bytes),
          byteLength: bytes.byteLength,
        }))
      }
      return Promise.resolve(now)
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
      const init: RequestInit & { duplex?: "half" } = {
        method: this.method,
        headers: this.headers,
        signal: controller.signal,
      }
      if (this.method !== "GET" && this.method !== "HEAD") {
        if (this.streamState !== undefined) {
          const stream = this.body
          if (stream !== null) {
            init.body = stream
            init.duplex = "half"
          }
        } else {
          const bytes = this.toBytes()
          if (bytes !== null) init.body = bytes.slice()
        }
      }
      const built: Request = FORBIDDEN_FETCH_METHODS.has(this.method.toUpperCase())
        ? (() => {
            const bytes = this.toBytes()
            const rawBody =
              this.streamState !== undefined
                ? this.body
                : bytes !== null && bytes.byteLength > 0
                  ? new ReadableStream<Uint8Array<ArrayBuffer>>({
                      start(ctrl) {
                        ctrl.enqueue(bytes.slice())
                        ctrl.close()
                      },
                    })
                  : null
            return new RawMethodRequest(this, controller.signal, rawBody)
          })()
        : new Request(this.url, init)
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: every engine-served request is tagged with its source for per-request controls (trailers, early hints, mTLS peer cert)
      ;(built as SourcedRequest)[SOURCE] = this
      this.requestValue = built
      return built
    }
    return this.requestValue
  }
}

interface RustWsEntry {
  readonly nifra: NifraWs
  readonly upgrade: WsUpgrade
  readonly asyncScope: AsyncResource
  state: number
  sentClose: readonly [number, string] | undefined
  readonly safe: (call: () => void | Promise<void>) => void
  readonly reportError: (error: unknown) => void
  readonly closeSocket: (code?: number, reason?: string) => void
}

/** A timeout the engine takes, or `undefined` to keep its default. */
const nativeMs = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(Math.round(value), MAX_NATIVE_LENGTH)
    : undefined

async function serveWithNodeFallback(
  app: FetchHandler,
  options: ServeOptions,
): Promise<EngineServer> {
  if (options.path !== undefined) {
    throw new TypeError(
      "@nifrajs/node-engine: Unix domain socket `path` is not supported by `@nifrajs/node` fallback",
    )
  }
  if (options.engine?.listenerFd !== undefined) {
    throw new TypeError(
      "@nifrajs/node-engine: `engine.listenerFd` is not supported by `@nifrajs/node` fallback",
    )
  }
  if (options.maxBodySize !== undefined) {
    throw new TypeError(
      "@nifrajs/node-engine: `maxBodySize` is not supported by `@nifrajs/node` fallback",
    )
  }
  if (options.oversizeWindow !== undefined) {
    throw new TypeError(
      "@nifrajs/node-engine: `oversizeWindow` is not supported by `@nifrajs/node` fallback",
    )
  }
  if (options.wsMaxMessageSize !== undefined) {
    throw new TypeError(
      "@nifrajs/node-engine: `wsMaxMessageSize` is not supported by `@nifrajs/node` fallback",
    )
  }
  const tlsOpt = options.tls
  const certVal =
    tlsOpt === undefined
      ? undefined
      : (pemToString(tlsOpt.cert) ??
        (tlsOpt.cert_file_name !== undefined ? readFileSync(tlsOpt.cert_file_name) : undefined))
  const keyVal =
    tlsOpt === undefined
      ? undefined
      : (pemToString(tlsOpt.key) ??
        (tlsOpt.key_file_name !== undefined ? readFileSync(tlsOpt.key_file_name) : undefined))
  const caVal =
    tlsOpt === undefined
      ? undefined
      : (pemBundleToString(tlsOpt.ca) ??
        (tlsOpt.ca_file_name !== undefined ? readFileSync(tlsOpt.ca_file_name) : undefined))
  const crlVal =
    tlsOpt === undefined
      ? undefined
      : (pemBundleToString(tlsOpt.crl) ??
        (tlsOpt.crl_file_name !== undefined ? readFileSync(tlsOpt.crl_file_name) : undefined))
  type NodeServeOpts = Parameters<typeof serveNode>[1]
  type NodeTlsOpts = NonNullable<NodeServeOpts["tls"]>
  let tlsInput: NodeTlsOpts | undefined
  if (tlsOpt !== undefined) {
    const tlsMut: { -readonly [K in keyof NodeTlsOpts]: NodeTlsOpts[K] } = {}
    if (certVal !== undefined) tlsMut.cert = certVal
    if (keyVal !== undefined) tlsMut.key = keyVal
    if (tlsOpt.passphrase !== undefined) tlsMut.passphrase = tlsOpt.passphrase
    if (caVal !== undefined) tlsMut.ca = caVal
    if (crlVal !== undefined) tlsMut.crl = crlVal
    if (tlsOpt.requestCert !== undefined) tlsMut.requestCert = tlsOpt.requestCert
    if (tlsOpt.rejectUnauthorized !== undefined) {
      tlsMut.rejectUnauthorized = tlsOpt.rejectUnauthorized
    }
    if (tlsOpt.minVersion !== undefined) tlsMut.minVersion = tlsOpt.minVersion
    if (tlsOpt.maxVersion !== undefined) tlsMut.maxVersion = tlsOpt.maxVersion
    if (tlsOpt.ciphers !== undefined) tlsMut.ciphers = tlsOpt.ciphers
    if (tlsOpt.ecdhCurve !== undefined) tlsMut.ecdhCurve = tlsOpt.ecdhCurve
    if (tlsOpt.ticketKeys !== undefined) tlsMut.ticketKeys = toTicketBuffer(tlsOpt.ticketKeys)
    tlsInput = tlsMut
  }
  const unsupported = (op: string): never => {
    throw new Error(
      `@nifrajs/node-engine: \`${op}()\` is not supported while running on \`@nifrajs/node\` fallback`,
    )
  }
  const nodeOpts: { -readonly [K in keyof NodeServeOpts]: NodeServeOpts[K] } = {
    port: options.port ?? 0,
  }
  if (options.hostname !== undefined) nodeOpts.hostname = options.hostname
  if (options.protocol !== undefined) nodeOpts.protocol = options.protocol
  if (tlsInput !== undefined) nodeOpts.tls = tlsInput
  if (options.static !== undefined) nodeOpts.static = options.static
  if (options.fastResponse !== undefined) nodeOpts.fastResponse = options.fastResponse
  if (options.allowedHosts !== undefined) nodeOpts.allowedHosts = options.allowedHosts
  if (options.canonicalHost !== undefined) nodeOpts.canonicalHost = options.canonicalHost
  if (options.normalizeTarget !== undefined) nodeOpts.normalizeTarget = options.normalizeTarget
  if (options.gracefulSignals !== undefined) nodeOpts.gracefulSignals = options.gracefulSignals
  const nodeServer = await serveNode(app, nodeOpts)
  return {
    port: nodeServer.port,
    stop: (stopOpts) => nodeServer.stop(stopOpts),
    reloadTls: () => unsupported("reloadTls"),
    addServerName: () => unsupported("addServerName"),
    removeServerName: () => unsupported("removeServerName"),
    [Symbol.asyncDispose]: () => nodeServer[Symbol.asyncDispose](),
  }
}

export function serve(app: FetchHandler, options: ServeOptions): Promise<EngineServer> {
  if (options.fastResponse !== undefined && typeof options.fastResponse !== "boolean") {
    throw new TypeError("@nifrajs/node-engine: `fastResponse` must be a boolean")
  }
  if (options.fallback !== undefined && typeof options.fallback !== "boolean") {
    throw new TypeError("@nifrajs/node-engine: `fallback` must be a boolean")
  }
  if (options.path !== undefined) {
    if (typeof options.path !== "string" || options.path.length === 0) {
      throw new TypeError("@nifrajs/node-engine: `path` must be a non-empty socket path")
    }
    if (options.port !== undefined) {
      throw new TypeError(
        "@nifrajs/node-engine: `path` and `port` cannot both be specified; pass one",
      )
    }
  } else if (
    (options.port !== undefined || options.engine?.listenerFd === undefined) &&
    (typeof options.port !== "number" || !Number.isInteger(options.port) || options.port < 0)
  ) {
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
  if (options.onConnect !== undefined && typeof options.onConnect !== "function") {
    throw new TypeError("@nifrajs/node-engine: `onConnect` must be a function")
  }
  const hasHostPolicy = options.allowedHosts !== undefined || options.canonicalHost !== undefined
  if (options.validateHost === false && hasHostPolicy) {
    throw new TypeError(
      "@nifrajs/node-engine: `validateHost: false` is not supported with `allowedHosts` or `canonicalHost`",
    )
  }
  const staticResolver: StaticRequestResolver | undefined =
    options.static === undefined ? undefined : createStaticResolver(options.static)
  if (options.fastResponse === true) installFastResponse()
  const policy = hostPolicyOf(options)
  const protocol = options.protocol ?? (options.tls === undefined ? "http" : "https")
  if (protocol !== "http" && protocol !== "https") {
    throw new TypeError(`@nifrajs/node-engine: protocol must be "http" or "https"`)
  }

  let addon: RustAddon
  try {
    addon = loadRustAddon()
  } catch (err) {
    if (options.fallback === true) {
      return serveWithNodeFallback(app, options)
    }
    throw err
  }
  activateAsyncContextFrame()
  // Capture the caller's AsyncLocalStorage store at `serve()` time so callbacks invoked directly
  // from native code inherit it without leaking `enterWith()` mutations across requests.
  const serveScope = new AsyncResource("nifra.node-engine.serve")
  let currentRequestScope: AsyncResource | undefined
  enableNodeDirect(app)
  const reporter = errorReporterOf(app)
  // Reporting happens inside recovery paths, which a throwing logger must not cut short.
  const report =
    reporter &&
    ((error: unknown): void => {
      try {
        reporter(error)
      } catch {
        // nowhere left to report it
      }
    })
  const lifecycle = lifecycleOf(app)
  const resolveNodeSource = app.resolveNodeSource
  const resolveWs = app.resolveWebSocketUpgrade
  const checkUpgrade = resolveWs === undefined || mayServeSockets(app)
  const policedHost = options.allowedHosts !== undefined || options.canonicalHost !== undefined
  const checkHost = options.validateHost === true || policedHost
  const host = options.hostname ?? "0.0.0.0"
  const bindPort = options.port ?? 0
  const unixPath = options.path

  // The native caps are u32: a larger one, the app's own included, is held to the largest it takes.
  const wsDeclared = options.wsMaxMessageSize ?? payloadCeiling(app)
  const wsCap = wsDeclared === undefined ? undefined : Math.min(wsDeclared, MAX_NATIVE_LENGTH)
  const maxBodySize = Math.min(
    options.maxBodySize ?? Math.max(DEFAULT_MAX_BODY_SIZE, bodyCeiling(app) ?? 0),
    MAX_NATIVE_LENGTH,
  )
  const oversizeWindow = options.oversizeWindow ?? DEFAULT_OVERSIZE_WINDOW
  const writeHighWaterMark = optionalPositiveCap(
    "writeHighWaterMark",
    options.engine?.writeHighWaterMark,
  )
  const responseBackpressureLimit = optionalPositiveCap(
    "responseBackpressureLimit",
    options.engine?.responseBackpressureLimit,
  )
  const nativeWriteBudget =
    responseBackpressureLimit === undefined
      ? MAX_NATIVE_LENGTH
      : Math.max(
          1,
          responseBackpressureLimit -
            Math.min(CHUNK_FRAMING_HEADROOM, Math.floor(responseBackpressureLimit / 2)),
        )
  const bufferedResponseLimit = Math.min(
    writeHighWaterMark ?? MAX_BUFFERED_RESPONSE_BYTES,
    nativeWriteBudget,
  )
  const streamChunkBytes = Math.min(STREAM_CHUNK_BYTES, bufferedResponseLimit)

  let uvServer: RustUvServer
  let bufs: RustBatchBuffers
  const inflight = new Map<number, RustBatchSource>()
  const wsSockets = new Map<number, RustWsEntry>()
  const connectTunnels = new Map<number, ConnectTunnelSocket>()
  let serverHandleRef: EngineServer = {
    port: 0,
    stop: async () => {},
    reloadTls: () => {},
    addServerName: () => {},
    removeServerName: () => false,
    [Symbol.asyncDispose]: async () => {},
  }
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
    source.diag?.finish(source.responseStatus)
    inflight.delete(source.requestId)
    source.release()
  }

  const fail = (source: RustBatchSource, error: unknown): void => {
    report?.(error)
    if (!source.aborted && !source.settled) {
      // The engine throws when it fails here; this is the last handler, so it only reports.
      try {
        if (source.headWritten) {
          // A clean end would tell the client (and any cache) the truncated body is whole.
          uvServer.abortStream(source.requestId)
        } else {
          source.responseStatus = 500
          uvServer.respondPrepared(source.requestId, tpl500, INTERNAL_ERROR_BUF)
          source.headWritten = true
        }
      } catch (engineError) {
        report?.(engineError)
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
    source.responseStatus = status
    const bodyless = isBodyless(status)
    const flat = validateAndBuildFlatHeaders(
      status,
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

  const pumpBuffer = async (
    source: RustBatchSource,
    status: number,
    headers: HeaderRecord | undefined,
    cookies: readonly string[] | undefined,
    bytes: Uint8Array,
    defaultType: string | undefined,
    len: number,
  ): Promise<void> => {
    const flat = validateAndBuildFlatHeaders(status, headers, cookies, defaultType)
    if (len > MAX_CONTENT_LENGTH) {
      throw new RangeError(`Content-Length ${len} is larger than the engine can frame`)
    }
    let unblock: (() => void) | undefined
    source.onAbort = () => unblock?.()
    source.onWritable = () => unblock?.()
    if (!uvServer.writeHead(source.requestId, status, flat, len)) return
    source.headWritten = true

    for (let offset = 0; offset < len && !source.aborted; offset += streamChunkBytes) {
      const chunkLen = Math.min(streamChunkBytes, len - offset)
      const buf = Buffer.from(bytes.buffer, bytes.byteOffset + offset, chunkLen)
      if (offset + chunkLen === len) {
        uvServer.end(source.requestId, buf)
        return
      }
      if (!uvServer.write(source.requestId, buf)) {
        await new Promise<void>((resolveWrite) => {
          unblock = resolveWrite
        })
      }
    }
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
    const unframeable = declared !== undefined && declared > MAX_CONTENT_LENGTH
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

    if (finished && (pending[0]?.byteLength ?? 0) <= bufferedResponseLimit) {
      const [first] = pending
      const only =
        first === undefined ? null : pending.length === 1 ? first : Buffer.concat(pending)
      writeBuffered(source, status, headers, cookies, only, false, defaultType)
      return
    }

    const flat = validateAndBuildFlatHeaders(status, headers, cookies, defaultType)
    // The native writer takes a u32 and would wrap a larger value into a short, wrong length.
    if (unframeable) {
      void reader.cancel().catch(() => {})
      throw new RangeError(`Content-Length ${declared} is larger than the engine can frame`)
    }
    if (!uvServer.writeHead(source.requestId, status, flat, declared ?? null)) {
      void reader.cancel().catch(() => {})
      return
    }
    source.headWritten = true

    let sent = 0
    let done = false
    // Return the next byte offset only if the native writer needs to drain.
    const writeAvailable = (chunk: Uint8Array, startOffset: number): number | undefined => {
      for (
        let offset = startOffset;
        offset < chunk.byteLength && !source.aborted;
        offset += streamChunkBytes
      ) {
        const len = Math.min(streamChunkBytes, chunk.byteLength - offset)
        const buf = Buffer.from(chunk.buffer, chunk.byteOffset + offset, len)
        sent += len
        if (declared !== undefined && sent === declared) {
          void reader.cancel().catch(() => {})
          uvServer.end(source.requestId, buf)
          done = true
          return undefined
        }
        if (!uvServer.write(source.requestId, buf)) return offset + len
      }
      return undefined
    }
    const drainRemainder = async (chunk: Uint8Array, startOffset: number): Promise<void> => {
      let offset: number | undefined = startOffset
      while (offset !== undefined && !source.aborted) {
        await new Promise<void>((resolveWrite) => {
          unblock = resolveWrite
        })
        offset = writeAvailable(chunk, offset)
      }
    }
    const sendChunk = (chunk: Uint8Array): Promise<void> | undefined => {
      if (declared !== undefined && sent + chunk.byteLength > declared) {
        void reader.cancel().catch(() => {})
        throw new RangeError("response body is longer than its Content-Length")
      }
      const offset = writeAvailable(chunk, 0)
      return offset === undefined ? undefined : drainRemainder(chunk, offset)
    }

    for (const chunk of pending) {
      const wait = sendChunk(chunk)
      if (wait !== undefined) await wait
      if (source.aborted || done) return
    }
    for (;;) {
      const next = await (carried ?? reader.read())
      carried = undefined
      if (source.aborted) return
      if (next.done) break
      if (next.value.byteLength === 0) continue
      const wait = sendChunk(next.value)
      if (wait !== undefined) await wait
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
        source.responseStatus = status
        const cookies = outcome.kind === "json" ? outcome.cookies : undefined
        const type = outcome.kind === "json" ? JSON_CONTENT_TYPE : defaultBodyType
        const len = typeof body === "string" ? Buffer.byteLength(body) : (body?.byteLength ?? 0)
        if (
          headers === undefined &&
          cookies === undefined &&
          !isHead &&
          !isBodyless(status) &&
          len <= bufferedResponseLimit &&
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
          len > bufferedResponseLimit
        ) {
          const bytes = typeof body === "string" ? Buffer.from(body) : body
          pumpBuffer(source, status, headers, cookies, bytes, type, len).then(
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
      source.responseStatus = status
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

  class ConnectTunnelSocket extends Duplex {
    tunnelId: number | undefined
    accepted = false
    private paused = false
    private drainCallback: ((error?: Error | null) => void) | undefined
    readonly source: RustBatchSource
    readonly asyncScope: AsyncResource

    constructor(source: RustBatchSource, asyncScope: AsyncResource) {
      super()
      this.source = source
      this.asyncScope = asyncScope
    }

    ensureAccepted(): boolean {
      if (this.accepted) return this.tunnelId !== undefined
      this.accepted = true
      if (closed || this.source.aborted || this.source.settled) return false
      const res = uvServer.acceptConnect(this.source.requestId)
      inflight.delete(this.source.requestId)
      this.source.settled = true
      this.source.headWritten = true
      this.source.release()
      if (res === null) return false
      this.tunnelId = res.tunnelId
      connectTunnels.set(res.tunnelId, this)
      if (res.head.byteLength > 0 && !this.push(res.head)) {
        this.paused = true
        uvServer.tunnelPause(res.tunnelId)
      }
      return true
    }

    override _read(): void {
      if (this.paused && this.tunnelId !== undefined) {
        this.paused = false
        uvServer.tunnelResume(this.tunnelId)
      }
    }

    override _write(
      chunk: Buffer | Uint8Array | string,
      encoding: BufferEncoding,
      callback: (error?: Error | null) => void,
    ): void {
      if (!this.ensureAccepted() || this.tunnelId === undefined) {
        callback(new Error("CONNECT tunnel closed"))
        return
      }
      const buf = Buffer.isBuffer(chunk)
        ? chunk
        : typeof chunk === "string"
          ? Buffer.from(chunk, encoding)
          : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      const res = uvServer.tunnelWrite(this.tunnelId, buf)
      if (res < 0) {
        callback(new Error("CONNECT tunnel closed"))
      } else if (res === 1) {
        callback()
      } else {
        this.drainCallback = callback
      }
    }

    override _final(callback: (error?: Error | null) => void): void {
      if (this.tunnelId !== undefined) {
        uvServer.tunnelEnd(this.tunnelId)
      }
      callback()
    }

    override _destroy(err: Error | null, callback: (error?: Error | null) => void): void {
      const cb = this.drainCallback
      this.drainCallback = undefined
      if (cb !== undefined) cb(err ?? new Error("CONNECT tunnel destroyed"))
      if (this.tunnelId !== undefined) {
        connectTunnels.delete(this.tunnelId)
        uvServer.tunnelDestroy(this.tunnelId)
        this.tunnelId = undefined
      } else if (!this.source.settled && !this.source.aborted) {
        fail(this.source, err ?? new Error("CONNECT tunnel destroyed"))
      }
      callback(err)
    }

    onEngineData(chunk: Buffer): void {
      if (this.destroyed) return
      if (!this.push(chunk)) {
        this.paused = true
        if (this.tunnelId !== undefined) uvServer.tunnelPause(this.tunnelId)
      }
    }

    onEngineEnd(): void {
      if (this.tunnelId !== undefined) {
        connectTunnels.delete(this.tunnelId)
      }
      const cb = this.drainCallback
      this.drainCallback = undefined
      if (cb !== undefined) cb(new Error("CONNECT tunnel closed"))
      this.push(null)
    }

    onEngineDrain(): void {
      const cb = this.drainCallback
      this.drainCallback = undefined
      if (cb !== undefined) cb()
    }
  }

  const dispatchConnect = (
    source: RustBatchSource,
    handler: NonNullable<ServeOptions["onConnect"]>,
  ): void => {
    const scope = source.asyncScope ?? serveScope
    const socket = new ConnectTunnelSocket(source, scope)
    const settle = (settled: Response | undefined): void => {
      if (settled instanceof Response) {
        if (!socket.accepted && !source.settled && !source.aborted) {
          settleOutcome(source, { kind: "response", response: settled }, false)
        } else {
          socket.destroy()
        }
        return
      }
      if (!socket.accepted && !source.settled && !source.aborted) {
        if (!socket.ensureAccepted()) socket.destroy()
      }
    }
    try {
      const out = handler(source.request, socket, Buffer.alloc(0))
      if (out instanceof Promise) {
        out.then(settle, (err: unknown) => {
          if (!socket.accepted && !source.settled && !source.aborted) fail(source, err)
          else socket.destroy(err instanceof Error ? err : undefined)
        })
      } else {
        settle(out)
      }
    } catch (err) {
      if (!socket.accepted && !source.settled && !source.aborted) fail(source, err)
      else socket.destroy(err instanceof Error ? err : undefined)
    }
  }

  const outcomeOf = (source: RustBatchSource): NodeServeOutcome | Promise<NodeServeOutcome> => {
    if (resolveNodeSource !== undefined) {
      return resolveNodeSource.call(app, source, source, nodeOutcomeRuntime)
    }
    const response = app.fetch(source.request, source)
    return response instanceof Response
      ? { kind: "response", response }
      : Promise.resolve(response).then(
          (settled): NodeServeOutcome => ({
            kind: "response",
            response: settled,
          }),
        )
  }

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
    // A throw here would reach no handler and end the process. The slots are dropped either way.
    try {
      uvServer.flushResponses(outCount)
    } catch (error) {
      report?.(error)
    }
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
    outMeta[ob + 4] = 0
    outOff += len
    outCount += 1
    return true
  }

  /** `queueSync` for a response with its own header lines; `block` is never empty. */
  const queueBlock = (
    reqId: number,
    status: number,
    block: string,
    body: string | Uint8Array,
  ): boolean => {
    const bodyUnits = typeof body === "string" ? body.length * 3 : body.byteLength
    const bound = block.length * 3 + bodyUnits
    if ((outCount + 1) * outSlotU32s > outMeta.length || bound > maxOutBytes - outOff) {
      flush()
      if (bound > maxOutBytes) return false
    }
    const blockLen = outData.write(block, outOff, "utf8")
    const bodyAt = outOff + blockLen
    const len = typeof body === "string" ? outData.write(body, bodyAt, "utf8") : body.byteLength
    if (typeof body !== "string") outData.set(body, bodyAt)
    const ob = outCount * outSlotU32s
    outMeta[ob] = reqId
    outMeta[ob + 1] = status
    outMeta[ob + 2] = outOff
    outMeta[ob + 3] = len
    outMeta[ob + 4] = blockLen
    outOff = bodyAt + len
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

  const outcomeBodyBytes = (body: string | Uint8Array | null | undefined): number => {
    if (body === null || body === undefined) return 0
    if (typeof body === "string") {
      return body.length * 3 <= bufferedResponseLimit ? body.length * 3 : Buffer.byteLength(body)
    }
    return body.byteLength
  }

  /** Queues a plain json or text outcome into the out slab; `false` when it needs the full writer. */
  const queueOutcome = (reqId: number, outcome: NodeServeOutcome, isHead: boolean): boolean => {
    if (isHead || outcome.kind === "response") return false
    const { status, headers } = outcome
    if (isBodyless(status)) return false
    const cookies = outcome.kind === "json" ? outcome.cookies : undefined
    const body = outcome.body ?? ""
    if (outcomeBodyBytes(body) > bufferedResponseLimit) return false
    if (headers === undefined && cookies === undefined) {
      const template = outcome.kind === "json" ? jsonTemplate(status) : textTemplate(status)
      return queueSync(reqId, template, body)
    }
    if (!Number.isInteger(status) || status < 100 || status > 999) return false
    const type = outcome.kind === "json" ? JSON_CONTENT_TYPE : undefined
    const block = headerBlock(headers, cookies, type)
    // An empty block would read as a templated slot.
    return block !== undefined && block !== "" && queueBlock(reqId, status, block, body)
  }

  const defaultOutcomeContentType = (
    outcome: NodeServeOutcome,
    isHead: boolean,
  ): string | undefined =>
    outcome.kind === "body" && outcome.headers === undefined && !isHead
      ? "text/plain; charset=utf-8"
      : undefined

  const settleOutcome = (
    source: RustBatchSource,
    outcome: NodeServeOutcome,
    isHead: boolean,
  ): void => {
    // Runs from promise continuations too, where a throw would be an unhandled rejection.
    try {
      if (!source.aborted && !source.settled && queueOutcome(source.requestId, outcome, isHead)) {
        source.responseStatus =
          outcome.kind === "response" ? outcome.response.status : outcome.status
        finish(source)
        flushSoon()
        return
      }
      writeComplexOutcome(source, outcome, isHead, defaultOutcomeContentType(outcome, isHead))
    } catch (error) {
      fail(source, error)
    }
  }

  const dispatchBatched = (i: number): void => {
    const { inMeta, inData, inSlotU32s } = bufs
    const b = i * inSlotU32s
    const reqId = inMeta[b] ?? 0
    const flags = inMeta[b + 1] ?? 0

    let authority: string | undefined
    if (policedHost) {
      authority = resolveRequestHost(uvServer.getHeader(reqId, "host") ?? undefined, policy)
      if (authority === undefined) {
        queueSync(reqId, tpl400, BAD_REQUEST_BODY)
        return
      }
    } else if (checkHost) {
      // The engine's syntax check is the cheap early refusal; the authority is then normalised as
      // a Host policy would, so `EXAMPLE.COM:080` builds the same URL under either option.
      if ((flags & FLAG_HOST_VALID) === 0) {
        queueSync(reqId, tpl400, BAD_REQUEST_BODY)
        return
      }
      authority = resolveRequestHost(uvServer.getHeader(reqId, "host") ?? undefined, policy)
      if (authority === undefined) {
        queueSync(reqId, tpl400, BAD_REQUEST_BODY)
        return
      }
    } else if ((flags & FLAG_HOST_VALID) === 0) {
      // `validateHost` off leaves the Host unchecked, but the URL carries it: one holding a URL
      // delimiter (or nothing, which swallows the first path segment) would give `req.url` a path
      // the router never saw. The flag spares the plain forms this engine call.
      const sent = uvServer.getHeader(reqId, "host")
      if (sent === "") {
        authority = "localhost"
      } else if (sent !== null && URL_DELIMITER.test(sent)) {
        queueSync(reqId, tpl400, BAD_REQUEST_BODY)
        return
      }
    }

    if ((flags & FLAG_OVER_MAX_BODY) !== 0) {
      queueSync(reqId, tpl413, PAYLOAD_TOO_LARGE_BODY)
      return
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
    const rawQuery = queryLen === 0 ? "" : inData.toString("latin1", queryOff, queryOff + queryLen)
    const asSent = queryLen === 0 ? rawPath : `${rawPath}?${rawQuery}`
    const target = resolveRequestTarget(asSent, policy.normalizeTarget)
    const queryStart =
      target === asSent ? (queryLen === 0 ? -1 : rawPath.length) : target.indexOf("?")
    const pathname = queryStart === -1 ? target : target.slice(0, queryStart)
    const search = queryStart === -1 ? "" : target.slice(queryStart)

    let bodyText: string | null = null
    let bodyBytes: Uint8Array<ArrayBuffer> | null | undefined
    if ((flags & FLAG_HAS_BODY) !== 0 && (flags & (FLAG_LARGE_BODY | FLAG_STREAM_BODY)) === 0) {
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
      return
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
    source.asyncScope = currentRequestScope
    if (hasHttpDiagnosticsSubscribers()) {
      source.diag = beginHttpDiagnostics(source.request, source, serverHandleRef)
    }

    if (staticResolver !== undefined && (methodIdx === 0 || methodIdx === 5)) {
      let staticAnswer: NodeServeOutcome | Promise<NodeServeOutcome | undefined> | undefined
      try {
        staticAnswer = staticResolver(
          method,
          pathname,
          (name) => source.header(name),
          () => source.request,
          authority,
        )
      } catch (err) {
        inflight.set(reqId, source)
        fail(source, err)
        return
      }
      if (staticAnswer !== undefined) {
        if (staticAnswer instanceof Promise) {
          inflight.set(reqId, source)
          staticAnswer.then(
            (settled) => {
              if (source.aborted || source.settled) return
              if (settled === undefined) {
                if (isWsHandshake) upgradeSocket(source)
                else dispatchHttp(source, isHead)
              } else {
                writeComplexOutcome(source, settled, isHead)
              }
            },
            (err: unknown) => fail(source, err),
          )
        } else {
          settleOutcome(source, staticAnswer, isHead)
        }
        return
      }
    }

    if (isWsHandshake) {
      inflight.set(reqId, source)
      upgradeSocket(source)
      return
    }

    if (method === "CONNECT" && options.onConnect !== undefined) {
      inflight.set(reqId, source)
      dispatchConnect(source, options.onConnect)
      return
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
        source.responseStatus =
          outcome.kind === "response" ? outcome.response.status : outcome.status
        source.diag?.finish(source.responseStatus)
        source.settled = true
        source.release()
      } else {
        inflight.set(reqId, source)
        writeComplexOutcome(source, outcome, isHead, defaultOutcomeContentType(outcome, isHead))
      }
    } catch (err) {
      report?.(err)
      queueSync(reqId, tpl500, INTERNAL_ERROR_BODY)
      source.settled = true
      source.release()
    }
  }

  const dispatchIsolated = (index: number): void => {
    const reqScope = new AsyncResource("nifra.node-engine.request")
    const prev = currentRequestScope
    currentRequestScope = reqScope
    try {
      reqScope.runInAsyncScope(dispatchBatched, undefined, index)
    } finally {
      currentRequestScope = prev
    }
  }

  const onBatch = (count: number): void => {
    serveScope.runInAsyncScope(() => {
      for (let i = 0; i < count; i++) {
        try {
          dispatchIsolated(i)
        } catch (error) {
          // An exception out of this callback is uncaught and ends the process.
          report?.(error)
          const reqId = bufs.inMeta[i * bufs.inSlotU32s] ?? 0
          const source = inflight.get(reqId)
          if (source === undefined) queueSync(reqId, tpl500, INTERNAL_ERROR_BODY)
          else fail(source, error)
        }
      }
    })

    flush()
  }

  const dispatchHttp = (source: RustBatchSource, isHead = false): void => {
    try {
      const outcome = outcomeOf(source)
      if (outcome instanceof Promise) {
        outcome.then(
          (settled) => settleOutcome(source, settled, isHead),
          (err: unknown) => fail(source, err),
        )
      } else {
        settleOutcome(source, outcome, isHead)
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
            const deflateOverride: RustWsDeflateOptions | null =
              outcome.handler.deflate === undefined
                ? null
                : outcome.handler.deflate === false
                  ? { enabled: false }
                  : (toRustWsDeflate(outcome.handler.deflate) ?? null)
            socketId = uvServer.upgradeToWebSocket(source.requestId, deflateOverride)
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
      const wsRequest = source.isH2
        ? new Request(source.request, {
            headers: (() => {
              const h = new Headers(source.headers)
              h.set("upgrade", "websocket")
              return h
            })(),
          })
        : source.request
      const outcome = resolveWs.call(app, wsRequest, source)
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
      getBufferedAmount: () => (entry.state === WS_OPEN ? uvServer.wsGetBufferedAmount(id) : 0),
      getPeerCertificate: (detailed = false) =>
        buildPeerCertificate(uvServer.wsGetPeerCertificates(id), detailed),
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
      subscribe: (topic) => {
        if (nativePubsub) {
          if (entry.state === WS_OPEN) uvServer.wsSubscribe(id, topic)
        } else {
          pubsub.subscribe(topic, nifra)
        }
      },
      unsubscribe: (topic) => {
        if (nativePubsub) uvServer.wsUnsubscribe(id, topic)
        else pubsub.unsubscribe(topic, nifra)
      },
      getBufferedAmount: () => handle.getBufferedAmount(),
      cork: (callback) => {
        if (entry.state !== WS_OPEN || !uvServer.wsCorkBegin(id)) {
          callback()
          return
        }
        try {
          callback()
        } finally {
          uvServer.wsCorkEnd(id)
        }
      },
      data,
      raw: handle,
    }
    const wsScope = new AsyncResource("nifra.node-engine.ws")
    const entry: RustWsEntry = {
      nifra,
      upgrade,
      asyncScope: wsScope,
      state: WS_OPEN,
      sentClose: undefined,
      safe,
      reportError,
      closeSocket,
    }
    wsSockets.set(id, entry)
    new AsyncResource("nifra.node-engine.ws-event").runInAsyncScope(() => {
      safe(() => handler.open?.(nifra))
    })
  }

  let currentTls = options.tls
  const http2Enabled = options.http2 !== undefined && options.http2 !== false
  const rustHttp2 =
    typeof options.http2 === "object" && options.http2 !== null
      ? toRustHttp2(options.http2)
      : undefined
  const idleTimeoutMs = optionalNonNegMs("idleTimeoutMs", options.engine?.idleTimeoutMs)
  const responseTimeoutMs = optionalNonNegMs("responseTimeoutMs", options.engine?.responseTimeoutMs)
  const requestTimeoutMs = optionalNonNegMs("requestTimeoutMs", options.engine?.requestTimeoutMs)
  const wsMaxLifetimeMs = optionalNonNegMs("wsMaxLifetimeMs", options.engine?.wsMaxLifetimeMs)
  const maxConnections = optionalNonNegCap("maxConnections", options.engine?.maxConnections)
  const headersTimeoutMs = nativeMs(options.engine?.headersTimeoutMs)
  const maxHeaderBytes =
    optionalPositiveCap("maxHeaderBytes", options.engine?.maxHeaderBytes) ??
    optionalPositiveCap("maxHeadSize", options.engine?.maxHeadSize)
  const maxHeaders = optionalPositiveCap("maxHeaders", options.engine?.maxHeaders)
  const maxUriSize = optionalPositiveCap("maxUriSize", options.engine?.maxUriSize)
  const maxPendingBytes = optionalPositiveCap("maxPendingBytes", options.engine?.maxPendingBytes)
  const backlog =
    options.engine?.backlog === undefined
      ? undefined
      : (() => {
          const b = options.engine.backlog
          if (!(isCap(b) && b <= 0x7fff_ffff)) {
            throw new TypeError(
              "@nifrajs/node-engine: `engine.backlog` must be a positive 32-bit integer",
            )
          }
          return b
        })()
  const wsMaxBackpressure = optionalNonNegCap(
    "wsMaxBackpressure",
    options.engine?.wsMaxBackpressure,
  )
  const wsCloseOnBackpressureLimit = options.engine?.wsCloseOnBackpressureLimit
  if (wsCloseOnBackpressureLimit !== undefined && typeof wsCloseOnBackpressureLimit !== "boolean") {
    throw new TypeError(
      "@nifrajs/node-engine: `engine.wsCloseOnBackpressureLimit` must be a boolean",
    )
  }
  const streamRequestBodies = options.engine?.streamRequestBodies
  if (streamRequestBodies !== undefined && typeof streamRequestBodies !== "boolean") {
    throw new TypeError("@nifrajs/node-engine: `engine.streamRequestBodies` must be a boolean")
  }
  const listenerFd = options.engine?.listenerFd
  if (
    listenerFd !== undefined &&
    (typeof listenerFd !== "number" || !Number.isInteger(listenerFd) || listenerFd < 0)
  ) {
    throw new TypeError("@nifrajs/node-engine: `engine.listenerFd` must be a non-negative integer")
  }
  const wsDeflate = toRustWsDeflate(options.wsDeflate)
  const rustCompression = toRustCompression(options.compression)
  const rustTls = currentTls === undefined ? undefined : toRustTls(currentTls)
  try {
    uvServer = addon.createUvServer(host, bindPort, onBatch, {
      maxBodySize,
      oversizeWindow,
      maxHeaders,
      maxUriSize,
      maxPendingBytes,
      idleTimeoutMs,
      responseTimeoutMs,
      responseBackpressureLimit,
      backlog,
      maxConnections,
      requestTimeoutMs,
      headersTimeoutMs,
      maxHeaderBytes,
      reusePort: options.engine?.reusePort,
      wsMaxMessageSize: wsCap,
      wsMaxLifetimeMs,
      wsMaxBackpressure,
      wsCloseOnBackpressureLimit,
      streamRequestBodies,
      compression: rustCompression,
      unixPath,
      listenerFd,
      wsDeflate,
      http2: http2Enabled ? true : undefined,
      ...rustHttp2,
      tls: rustTls,
    })
  } catch (cause) {
    const label = unixPath ?? `port ${bindPort}`
    return Promise.reject(
      new Error(`@nifrajs/node-engine: ${label} is not available to listen on`, {
        cause,
      }),
    )
  }
  type NativePublishFn = (topic: string, data: string | ArrayBufferView | ArrayBuffer) => void
  type InstallNativePublishFn = (publish: NativePublishFn, remove?: boolean) => boolean
  let nativePubsub = false
  let installedNativePublish: NativePublishFn | undefined
  const installNative = Reflect.get(app, INSTALL_NATIVE_PUBLISH)
  if (typeof installNative === "function") {
    const publishNative: NativePublishFn = (topic, data) => {
      if (closed) return
      if (typeof data === "string") {
        uvServer.wsPublishText(topic, data, null)
      } else if (data instanceof ArrayBuffer) {
        uvServer.wsPublish(topic, Buffer.from(data), true, null)
      } else {
        uvServer.wsPublish(
          topic,
          Buffer.from(data.buffer, data.byteOffset, data.byteLength),
          true,
          null,
        )
      }
    }
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: `INSTALL_NATIVE_PUBLISH` on `Server` returns `boolean` and accepts `(publish, remove?)`.
    const installer = installNative as InstallNativePublishFn
    nativePubsub = installer.call(app, publishNative, false)
    if (nativePubsub) installedNativePublish = publishNative
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
    if (!nativePubsub) {
      try {
        pubsub.unsubscribeAll(entry.nifra)
      } catch (error) {
        entry.reportError(error)
      }
    }
    const [finalCode, finalReason] = entry.sentClose ?? [
      code,
      peerReason || (code === 1009 ? "message too large" : ""),
    ]
    entry.safe(() => handler.close?.(entry.nifra, finalCode, finalReason))
  }
  /** The engine calls these with no JavaScript above them, so a throw would end the process. */
  const guarded =
    <A extends unknown[]>(run: (...args: A) => void) =>
    (...args: A): void => {
      try {
        run(...args)
      } catch (error) {
        report?.(error)
      }
    }
  const runInWsEventScope = (entry: RustWsEntry, fn: () => void): void => {
    entry.asyncScope.runInAsyncScope(() => {
      new AsyncResource("nifra.node-engine.ws-event").runInAsyncScope(fn)
    })
  }

  uvServer.setStreamCallbacks(
    guarded((reqId) => {
      const source = inflight.get(reqId)
      if (source === undefined) return
      const scope = source.asyncScope ?? serveScope
      scope.runInAsyncScope(() => source.onWritable?.())
    }),
    guarded((reqId) => {
      const source = inflight.get(reqId)
      const scope = source?.asyncScope ?? serveScope
      scope.runInAsyncScope(abortRequest, undefined, reqId)
    }),
  )
  if (streamRequestBodies === true) {
    uvServer.setReqBodyCallback(
      guarded((reqId, chunk, isLast) => {
        const source = inflight.get(reqId)
        if (source === undefined) return
        const scope = source.asyncScope ?? serveScope
        scope.runInAsyncScope(() => source.pushBodyChunk(chunk, isLast))
      }),
    )
  }
  uvServer.setWsCallbacks(
    guarded((socketId) => {
      if (openingWs !== undefined) {
        const scope = AsyncResource.bind((id: number, upgrade: WsUpgrade) => openWs(id, upgrade))
        scope(socketId, openingWs)
      }
    }),
    guarded((socketId, data) => {
      const entry = wsSockets.get(socketId)
      if (entry === undefined || entry.state !== WS_OPEN) return
      const { handler, maxPayloadBytes } = entry.upgrade
      if (maxPayloadBytes !== undefined && exceedsPayloadCap(data, maxPayloadBytes)) {
        runInWsEventScope(entry, () => entry.closeSocket(1009, "message too large"))
        return
      }
      const payload: NifraWsData = typeof data === "string" ? data : new Uint8Array(data)
      runInWsEventScope(entry, () => entry.safe(() => handler.message?.(entry.nifra, payload)))
    }),
    guarded((socketId, code, peerReason) => {
      const entry = wsSockets.get(socketId)
      if (entry === undefined) {
        finishSocket(socketId, code, peerReason)
        return
      }
      runInWsEventScope(entry, () => finishSocket(socketId, code, peerReason))
    }),
    guarded((socketId) => {
      const entry = wsSockets.get(socketId)
      if (entry === undefined || entry.state !== WS_OPEN) return
      const { handler } = entry.upgrade
      runInWsEventScope(entry, () => entry.safe(() => handler.drain?.(entry.nifra)))
    }),
  )
  if (options.onConnect !== undefined) {
    uvServer.setConnectCallbacks(
      guarded((tunnelId, chunk) => {
        const tunnel = connectTunnels.get(tunnelId)
        if (tunnel === undefined) return
        tunnel.asyncScope.runInAsyncScope(() => tunnel.onEngineData(chunk))
      }),
      guarded((tunnelId) => {
        const tunnel = connectTunnels.get(tunnelId)
        if (tunnel === undefined) return
        tunnel.asyncScope.runInAsyncScope(() => tunnel.onEngineEnd())
      }),
      guarded((tunnelId) => {
        const tunnel = connectTunnels.get(tunnelId)
        if (tunnel === undefined) return
        tunnel.asyncScope.runInAsyncScope(() => tunnel.onEngineDrain())
      }),
    )
  }
  bufs = uvServer.getBatchBuffers()
  outMeta = bufs.outMeta
  outData = bufs.outData
  outSlotU32s = bufs.outSlotU32s
  // A header slot needs the fifth field: an older addon would read its status as a template id.
  if (outSlotU32s < 5) {
    uvServer.close()
    throw new TypeError(
      "@nifrajs/node-engine: the native addon is older than this package, rebuild it",
    )
  }
  maxOutBytes = outData.byteLength
  tpl400 = textTemplate(400)
  tpl413 = jsonTemplate(413)
  tpl500 = jsonTemplate(500)
  tpl501 = jsonTemplate(501)

  // Register staticResponse() and echoParam() routes natively in Rust (0 JS calls).
  // Skip GET native routes when `static` middleware is active, since files win over GET routes.
  if (isServerView(app) && !checkHost && !policy.normalizeTarget) {
    for (const route of declarativeRoutes(app)) {
      if (route.method === "GET" && staticResolver !== undefined) continue
      const flat = fixedHeaders(route.headers)
      if (flat === undefined) continue
      if (route.method === "POST") {
        uvServer.setStaticPostRoute(route.path, route.status, flat, Buffer.alloc(0))
      } else if (route.param !== undefined) {
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
    if (installedNativePublish !== undefined && typeof installNative === "function") {
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: `INSTALL_NATIVE_PUBLISH` accepts `(publish, true)` to detach on stop.
      ;(installNative as InstallNativePublishFn).call(app, installedNativePublish, true)
      installedNativePublish = undefined
    }
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
      for (const tunnel of [...connectTunnels.values()]) tunnel.destroy()
    }
    await lifecycle("stopped")
  }

  const normalizeSniKey = (name: string): string => name.trim().replace(/\.$/, "").toLowerCase()

  const reloadTls = (tls: TlsOptions | undefined = currentTls): void => {
    if (closed) throw new Error("@nifrajs/node-engine: the server is not running")
    if (tls === undefined) {
      throw new Error("@nifrajs/node-engine: reloadTls requires a server started with `tls`")
    }
    uvServer.reloadTls(toRustTls(tls))
    currentTls = tls
  }

  const addServerName = (entry: TlsSniEntry): void => {
    if (closed) throw new Error("@nifrajs/node-engine: the server is not running")
    if (currentTls === undefined) {
      throw new Error("@nifrajs/node-engine: addServerName requires a server started with `tls`")
    }
    uvServer.addServerName(toRustTlsSni(entry))
    const key = normalizeSniKey(entry.serverName)
    const nextNames = (currentTls.serverNames ?? []).filter(
      (existing) => normalizeSniKey(existing.serverName) !== key,
    )
    nextNames.push(entry)
    currentTls = { ...currentTls, serverNames: nextNames }
  }

  const removeServerName = (serverName: string): boolean => {
    if (closed) throw new Error("@nifrajs/node-engine: the server is not running")
    const removed = uvServer.removeServerName(serverName)
    if (removed && currentTls?.serverNames !== undefined) {
      const key = normalizeSniKey(serverName)
      currentTls = {
        ...currentTls,
        serverNames: currentTls.serverNames.filter(
          (existing) => normalizeSniKey(existing.serverName) !== key,
        ),
      }
    }
    return removed
  }

  const serverHandle: {
    readonly port: number
    path?: string
    readonly stop: (options?: NodeStopOptions) => Promise<void>
    readonly reloadTls: (tls?: TlsOptions) => void
    readonly addServerName: (entry: TlsSniEntry) => void
    readonly removeServerName: (serverName: string) => boolean
    readonly [Symbol.asyncDispose]: () => Promise<void>
  } = {
    port: uvServer.port,
    stop,
    reloadTls,
    addServerName,
    removeServerName,
    [Symbol.asyncDispose]: () => stop(),
  }
  if (unixPath !== undefined) serverHandle.path = unixPath
  serverHandleRef = serverHandle
  return Promise.resolve(serverHandle)
}
