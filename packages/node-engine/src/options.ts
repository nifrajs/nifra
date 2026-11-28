/**
 * Option and handler types for `@nifrajs/node-engine`, and the
 * app-introspection helpers the server reads its limits from.
 */
import type { X509Certificate } from "node:crypto"
import type { Duplex } from "node:stream"
import type { HostPolicyOptions, NodeServeOutcome, NodeStopOptions } from "@nifrajs/node/transport"
import type { WsUpgradeOutcome } from "./generated/ws-types.ts"

export type { NodeStopOptions } from "@nifrajs/node/transport"

/** Parsed mTLS peer certificate information exposed by {@link getPeerCertificate}. */
export interface PeerCertificateInfo {
  readonly subject: string
  readonly issuer: string
  readonly subjectAltName: string | undefined
  readonly validFrom: string
  readonly validTo: string
  readonly serialNumber: string
  readonly fingerprint: string
  readonly fingerprint256: string
  readonly fingerprint512: string
  readonly raw: Buffer
  readonly x509: X509Certificate
  readonly issuerCertificate?: PeerCertificateInfo
}

/**
 * What `ws.raw` is on this transport: the engine keeps no socket object to hand out, so this is the
 * socket's id and what the engine still knows about its handshake.
 */
export interface EngineSocket {
  readonly id: number
  /** The handshake request's headers; names are lowercase. */
  headers(): Headers
  /** The handshake request's query string, without the `?`. */
  query(): string
  /** The peer's address, once the socket is open. */
  remoteAddress(): string | undefined
  /** Queued outbound socket bytes currently waiting for the peer to read. */
  getBufferedAmount(): number
  /** The mTLS client certificate presented on the underlying TLS connection, or `null`. */
  getPeerCertificate?(detailed?: boolean): PeerCertificateInfo | null
}

/** Per-hostname certificate entry for TLS Server Name Indication (SNI), matching exact or single-level wildcard (`*.example.com`). */
export interface TlsSniEntry {
  readonly serverName: string
  readonly cert?: string | ArrayBuffer | Uint8Array
  readonly key?: string | ArrayBuffer | Uint8Array
  readonly cert_file_name?: string
  readonly key_file_name?: string
  /** Passphrase protecting an encrypted private key PEM (`key` or `key_file_name`). */
  readonly passphrase?: string
}

/** Native HTTP response compression (`zstd`, `br`, `gzip`, `deflate`) negotiated via `Accept-Encoding`. */
export interface CompressionOptions {
  /** Enable or disable compression. Default `true` when an options object is passed. */
  readonly enabled?: boolean
  /** Allow Zstandard (`zstd`). Default `true`. */
  readonly zstd?: boolean
  /** Allow Brotli (`br`). Default `true`. */
  readonly brotli?: boolean
  /** Allow Gzip (`gzip`). Default `true`. */
  readonly gzip?: boolean
  /** Allow Deflate (`deflate`). Default `true`. */
  readonly deflate?: boolean
  /** Minimum uncompressed body length in bytes before compressing. Default `1024`. */
  readonly minBytes?: number
}

/** Native engine probe result describing loaded platform, transport, and capability flags. */
export interface ProbeResult {
  readonly ok: boolean
  readonly version: string
  readonly platform: string
  readonly arch: string
  readonly transport: string
  readonly reason?: string
  readonly capabilities: Readonly<Record<string, boolean>>
}

/** In-process TLS: inline PEM or file names, encrypted key passphrase, mTLS & TLS policy. */
export interface TlsOptions {
  readonly cert?: string | ArrayBuffer | Uint8Array
  readonly key?: string | ArrayBuffer | Uint8Array
  readonly cert_file_name?: string
  readonly key_file_name?: string
  /** Passphrase protecting an encrypted private key PEM (`key` or `key_file_name`). */
  readonly passphrase?: string
  /** Trusted CA PEM certificates for verifying client certificates (mTLS). */
  readonly ca?: string | ArrayBuffer | Uint8Array | readonly (string | ArrayBuffer | Uint8Array)[]
  /** Path to a PEM bundle of trusted CA certificates for client certificate verification (mTLS). */
  readonly ca_file_name?: string
  /** PEM Certificate Revocation List(s) checked during mTLS client authentication. */
  readonly crl?: string | ArrayBuffer | Uint8Array | readonly (string | ArrayBuffer | Uint8Array)[]
  /** Path to a PEM Certificate Revocation List file checked during mTLS client authentication. */
  readonly crl_file_name?: string
  /** Request a client certificate during TLS handshake. */
  readonly requestCert?: boolean
  /** Reject clients whose certificate fails verification or is absent when `requestCert` is true. Default `true` when `requestCert` is set. */
  readonly rejectUnauthorized?: boolean
  /** Minimum TLS protocol version allowed (`"TLSv1.2"` or `"TLSv1.3"`). */
  readonly minVersion?: "TLSv1.2" | "TLSv1.3"
  /** Maximum TLS protocol version allowed (`"TLSv1.2"` or `"TLSv1.3"`). */
  readonly maxVersion?: "TLSv1.2" | "TLSv1.3"
  /** Colon/space-separated TLS cipher list (IANA or OpenSSL names, or `!EXCLUDED`). */
  readonly ciphers?: string
  /** TLS 1.3 cipher suite list merged with {@link ciphers}. */
  readonly ciphersuites?: string
  /** Colon-separated ECDH/KEM key exchange group list (e.g. `"X25519:P-256:P-384"`). */
  readonly ecdhCurve?: string
  /** Additional SNI certificates keyed by hostname or single-level `*.domain` wildcard. */
  readonly serverNames?: readonly TlsSniEntry[]
  /**
   * Session-ticket keys: one or more 48-byte entries (16-byte name, 16-byte HMAC secret, 16-byte AES
   * key), newest first, so a rotation keeps resuming sessions. Share them across workers.
   */
  readonly ticketKeys?: string | ArrayBuffer | Uint8Array
}

/** RFC 7692 WebSocket `permessage-deflate` negotiation and compression settings. */
export interface WsDeflateOptions {
  /** Disallow server LZ77 context reuse across messages (`server_no_context_takeover`). */
  readonly serverNoContextTakeover?: boolean
  /** Request client to reset its LZ77 window per message (`client_no_context_takeover`). */
  readonly clientNoContextTakeover?: boolean
  /** Server deflate LZ77 window bits (9..15; 8 is rejected on server config and declined if offered by client). Default 15. */
  readonly serverMaxWindowBits?: number
  /** Client deflate LZ77 window bits (8..15). Default 15. */
  readonly clientMaxWindowBits?: number
  /** Minimum outgoing payload bytes before compressing (`0` compresses all frames). Default 0. */
  readonly threshold?: number
  /** Upper limit in bytes on decompressed incoming message size (zip-bomb defense). Defaults to `wsMaxMessageSize`. */
  readonly maxDecompressedSize?: number
  /** Compression level 1..9. Default 6. */
  readonly level?: number
  /** Reuse a single stateless compressor instead of allocating one per open WebSocket. */
  readonly sharedCompressor?: boolean
}

/** HTTP/2 settings the server advertises. */
export interface Http2Options {
  readonly maxConcurrentStreams?: number
  /** Flow-control window of each request body, in bytes. Default 1 MiB. */
  readonly initialWindowSize?: number
  /** Flow-control window of the whole connection, 65535 or more. Default 4 MiB. */
  readonly connectionWindowSize?: number
  /** Largest frame accepted, 16384 to 16777215. Default 16384. */
  readonly maxFrameSize?: number
  /** Bytes of each HPACK table, request and response side; 0 to 65536. Default 4096. */
  readonly headerTableSize?: number
  /**
   * Queued response bytes per connection. At this limit the next buffered response with a body is
   * reset with `ENHANCE_YOUR_CALM`, and past it a streamed one is told to wait. Default 16 MiB.
   */
  readonly maxSendBuffer?: number
  /**
   * Send a `PING` to a connection quiet for this long, and close it when no answer comes. A peer that
   * answers is not idle, so set this below `idleTimeoutMs` to keep a live one open. Timers are checked
   * once a second. Off by default (`0`).
   */
  readonly pingIntervalMs?: number
  /** Budget in ms for that answer. Default 20 s. */
  readonly pingTimeoutMs?: number
}

/** Engine limits and timeouts beyond the first-class options. */
export interface EngineTuning {
  /** Idle connection budget in ms. Quiet WebSockets receive a Ping before closing. 0 disables. Default 30 s. */
  readonly idleTimeoutMs?: number
  /** Budget in ms for a request head, and for a TLS handshake. 0 disables. Default 60 s. */
  readonly headersTimeoutMs?: number
  /** Largest request head, 431 beyond it. Default 16 KiB, as `node:http`. */
  readonly maxHeaderBytes?: number
  /** Stalled response budget in ms. Defaults to idleTimeoutMs. 0 disables. */
  readonly responseTimeoutMs?: number
  /** Budget in ms for one complete request, from its first byte; does not reset on activity. 0 disables. */
  readonly requestTimeoutMs?: number
  /** Most simultaneous connections; accepts beyond it are dropped. */
  readonly maxConnections?: number
  /** TCP listen backlog passed to `listen(2)`. Default 4096. */
  readonly backlog?: number
  /** Alias for maxHeaderBytes. maxHeaderBytes takes precedence. */
  readonly maxHeadSize?: number
  /** Maximum number of headers allowed on a request before replying 431. */
  readonly maxHeaders?: number
  /** Maximum length in bytes of the request target (URI + query) before replying 414. */
  readonly maxUriSize?: number
  /** Maximum queued bytes per HTTP/1.1 connection waiting behind an earlier pipelined request. Default 8 MiB. */
  readonly maxPendingBytes?: number
  /** Maximum queued outbound socket bytes before dropping a non-reading peer. Default 16 MiB. */
  readonly responseBackpressureLimit?: number
  /** Streaming chunk buffer / buffered response threshold in bytes. Default 2 MiB. */
  readonly writeHighWaterMark?: number
  /** Optional maximum lifetime in ms for any WebSocket connection. 0 disables. */
  readonly wsMaxLifetimeMs?: number
  /** Per-socket queued outbound byte threshold at which `ws.send()` rejects backpressured sends (0 = unlimited). */
  readonly wsMaxBackpressure?: number
  /** Close the WebSocket connection when queued bytes hit `wsMaxBackpressure`. */
  readonly wsCloseOnBackpressureLimit?: boolean
  /** Stream HTTP/1.1 & HTTP/2 request bodies incrementally to `req.body` instead of buffering whole payloads. */
  readonly streamRequestBodies?: boolean
  /** Inherit a pre-bound TCP listener descriptor (used by `serveCluster` with `sharedListener`). */
  readonly listenerFd?: number
  /** Bind with `SO_REUSEPORT` so several processes share the port. Off by default; `serveCluster` sets it. */
  readonly reusePort?: boolean
}

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
  /** Present on every nifra app: serves `app.ws()` routes. Absent, a handshake is refused with 501. */
  resolveWebSocketUpgrade?(
    request: Request,
    platform?: { readonly clientIp?: string | undefined },
  ): WsUpgradeOutcome | Promise<WsUpgradeOutcome>
}

/** Handler invoked for HTTP/1.1 or HTTP/2 `CONNECT` tunnel requests. */
export type ConnectHandler = (
  request: Request,
  socket: Duplex,
  head: Buffer,
) => undefined | Response | Promise<undefined | Response>

export interface ServeOptions extends HostPolicyOptions {
  /** TCP port to bind (`0` for ephemeral). Omit for {@link path} or an inherited listener descriptor. */
  readonly port?: number
  readonly hostname?: string
  /** Unix domain socket path to listen on (mutually exclusive with a TCP `hostname`/`port` bind). */
  readonly path?: string
  /** The scheme `Request.url` carries. `"https"` by default when {@link tls} is set, else `"http"`. */
  readonly protocol?: "http" | "https"
  /** In-process TLS, inline PEM or file names. */
  readonly tls?: TlsOptions
  /** Static file handler (`serveStatic(...)`) or custom middleware consulted before routes on GET/HEAD. */
  readonly static?: (request: Request) => Response | undefined | Promise<Response | undefined>
  /** Replace `globalThis.Response` with the lazy direct-write response wrapper to skip stream drains. */
  readonly fastResponse?: boolean
  /** Native HTTP response compression (`zstd`, `br`, `gzip`, `deflate`) negotiated via `Accept-Encoding`. */
  readonly compression?: boolean | CompressionOptions
  /** Fall back to `@nifrajs/node` (`node:http`/`node:https`) if the native addon binary cannot be loaded. Default `false`. */
  readonly fallback?: boolean
  /**
   * Largest request body the engine accepts, 413 beyond it. The engine buffers a body whole before
   * the app runs, so this bounds the memory one request can hold. Default: 1 MiB, or the largest
   * `maxBodyBytes` among the app and its mounted apps when that is more. A route with its own larger
   * `bodyLimit` needs this set to match.
   */
  readonly maxBodySize?: number
  /**
   * Bytes past {@link maxBodySize} the engine still buffers, so that a body only a little over the cap
   * is answered with the app's 413 body instead of the engine's empty one. A request can hold
   * `maxBodySize` plus this in memory. `0` turns it off: every body over the cap is refused natively
   * and the request path does no size check. Default 1 MiB.
   */
  readonly oversizeWindow?: number
  /**
   * Check every request's `Host` before the app runs: a malformed one is refused with a 400, and
   * `req.url` is built from its normalized form. Off by default, as `validateHost` is on the Bun and
   * Deno server: the check costs an engine call per request, and a server behind a proxy that already
   * checks `Host` gains nothing from it. Off, a `Host` holding a path, query, fragment or userinfo
   * delimiter is still refused (and an empty one read as `localhost`), so `req.url` never names a
   * path the router did not see; anything else the URL parser refuses (an out-of-range port, say)
   * makes `req.url` throw when read. Turn it on for a server that clients reach directly.
   * `allowedHosts` and `canonicalHost` need every `Host` read, so setting either turns it on.
   */
  readonly validateHost?: boolean
  /**
   * HTTP/2 beside HTTP/1.1 on the same port: negotiated by ALPN when {@link tls} is set, by prior
   * knowledge (a client opening with the HTTP/2 preface) when it is not. `true` takes the engine's
   * defaults; an object sets its settings.
   */
  readonly http2?: boolean | Http2Options
  /**
   * Largest WebSocket message the engine accepts before it fails the connection with 1009. Defaults to
   * the largest `wsMaxPayloadBytes` among the app and the apps mounted in it that serve sockets (a
   * route whose app declares less is held to its own), else the engine's 16 MiB. The Node fallback
   * rejects this option at startup.
   */
  readonly wsMaxMessageSize?: number
  /** Enable RFC 7692 WebSocket `permessage-deflate` compression (`true` for defaults, or options). */
  readonly wsDeflate?: boolean | WsDeflateOptions
  /** Any other engine limit or timeout, passed through as given. */
  readonly engine?: EngineTuning
  /** Optional handler for HTTP/1.1 and HTTP/2 `CONNECT` tunnel requests. */
  readonly onConnect?: ConnectHandler
  /** SIGTERM/SIGINT call `stop()`; off by default, as in `@nifrajs/node`. */
  readonly gracefulSignals?: boolean | NodeStopOptions
}

export interface EngineServer {
  /** The bound port (resolved when `port: 0` is requested, or `0` for Unix domain sockets). */
  readonly port: number
  /** Bound Unix domain socket path when started with `ServeOptions.path`. */
  readonly path?: string
  /**
   * Run the app's `onStopping` hooks, keep serving for `delayMs`, stop accepting connections, let
   * in-flight requests finish for up to `drainMs`, then close what is left and run `onStop`.
   */
  stop(options?: NodeStopOptions): Promise<void>
  /**
   * Replace the certificate and key (and cipher policy) used for every handshake from now on, with no
   * restart; connections already open keep the one they handshook with. `tls` is the whole
   * {@link ServeOptions.tls} shape, not a diff. With none it reads the current one again, which is how
   * a rotation of certificate *files* is picked up. Session tickets carry over, so resumption survives
   * a new certificate. Throws, leaving the certificate in place, on material the engine refuses; also
   * when the server has no TLS or has stopped.
   */
  reloadTls(tls?: NonNullable<ServeOptions["tls"]>): void
  /** Add or replace an SNI certificate entry at runtime without restarting the listener. */
  addServerName(entry: TlsSniEntry): void
  /** Remove an SNI certificate entry at runtime. Returns `true` if one was removed. */
  removeServerName(serverName: string): boolean
  [Symbol.asyncDispose](): Promise<void>
}

/** A cap the engine accepts: a positive integer. */
export const isCap = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0

/**
 * The largest `wsMaxPayloadBytes` among the app and the apps mounted under it that serve sockets, or
 * `undefined` when none is declared. The engine takes one limit per listener, so it has to admit every
 * mounted app's cap; a route whose app declares less is held to it by the hub. Reads each server's own
 * mount table by reflection, so a plain handler or an app with no socket routes names no cap.
 */
export function payloadCeiling(app: object): number | undefined {
  return ceilingOf(app, (node) => {
    const routes: unknown = Reflect.get(node, "wsRoutes")
    return Array.isArray(routes) && routes.length > 0
      ? Reflect.get(node, "wsMaxPayloadBytes")
      : undefined
  })
}

/**
 * Whether a handshake could be taken by this app or an app mounted in it. `false` only when that is
 * certain: an app with no socket route and mounts that each say, through the same `wsRuntime` seam
 * `listen()` asks, that nothing in them can take an upgrade. Anything the adapter cannot read counts as
 * able, so a handshake is only skipped when it would have been answered as a plain GET anyway.
 */
export function mayServeSockets(app: object): boolean {
  const routes: unknown = Reflect.get(app, "wsRoutes")
  if (!Array.isArray(routes) || routes.length > 0) return true
  const mounts: unknown = Reflect.get(app, "fetchMounts")
  if (!Array.isArray(mounts)) return true
  for (const mount of mounts) {
    if (typeof mount !== "object" || mount === null) return true
    const runtime: unknown = Reflect.get(mount, "wsRuntime")
    if (runtime === undefined) continue
    if (typeof runtime !== "function") return true
    if (Reflect.apply(runtime, mount, [new Set()]) !== undefined) return true
  }
  return false
}

/**
 * The largest `maxBodyBytes` among the app and the apps mounted under it, or `undefined` when none
 * is declared. The engine buffers a body before the app sees it, so a cap below what the app accepts
 * would refuse bodies the app allows, with an empty 413 and no way for the app to answer.
 */
export function bodyCeiling(app: object): number | undefined {
  return ceilingOf(app, (node) => Reflect.get(node, "maxBodyBytes"))
}

function ceilingOf(
  app: object,
  declared: (node: object) => unknown,
  seen = new Set<object>(),
): number | undefined {
  if (seen.has(app)) return undefined
  seen.add(app)
  let ceiling: number | undefined
  const take = (value: unknown): void => {
    if (isCap(value) && (ceiling === undefined || value > ceiling)) ceiling = value
  }
  take(declared(app))
  const mounts: unknown = Reflect.get(app, "fetchMounts")
  if (!Array.isArray(mounts)) return ceiling
  for (const mount of mounts) {
    const child: unknown = typeof mount === "object" && mount !== null ? mount.app : undefined
    if (typeof child === "object" && child !== null) take(ceilingOf(child, declared, seen))
  }
  return ceiling
}
