/**
 * EXPERIMENTAL - not for release. Option and handler types for `@nifrajs/node-engine`, and the
 * app-introspection helpers the server reads its limits from.
 */
import type { HostPolicyOptions, NodeServeOutcome, NodeStopOptions } from "@nifrajs/node/transport"
import type { WsUpgradeOutcome } from "./generated/ws-types.ts"

export type { NodeStopOptions } from "@nifrajs/node/transport"

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
}

/** In-process TLS: inline PEM or file names. */
export interface TlsOptions {
  readonly cert?: string | ArrayBuffer | Uint8Array
  readonly key?: string | ArrayBuffer | Uint8Array
  readonly cert_file_name?: string
  readonly key_file_name?: string
  /**
   * Session-ticket keys: one or more 48-byte entries (16-byte name, 16-byte HMAC secret, 16-byte AES
   * key), newest first, so a rotation keeps resuming sessions. Share them across workers.
   */
  readonly ticketKeys?: string | ArrayBuffer | Uint8Array
}

/** HTTP/2 settings the server advertises. */
export interface Http2Options {
  readonly maxConcurrentStreams?: number
}

/** Engine limits and timeouts beyond the first-class options. */
export interface EngineTuning {
  /**
   * Close a connection after this many ms with no bytes moving while it owes no response, or with a
   * response the peer takes none of. A quiet WebSocket is pinged first and closed only if the next
   * window passes unanswered. 0 disables. Default 30 s.
   */
  readonly idleTimeoutMs?: number
  /** Budget in ms for a request head, and for a TLS handshake. 0 disables. Default 60 s. */
  readonly headersTimeoutMs?: number
  /** Largest request head, 431 beyond it. Default 16 KiB, as `node:http`. */
  readonly maxHeaderBytes?: number
  /** Budget in ms for one complete request, from its first byte; does not reset on activity. 0 disables. */
  readonly requestTimeoutMs?: number
  /** Most simultaneous connections; accepts beyond it are dropped. */
  readonly maxConnections?: number
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

export interface ServeOptions extends HostPolicyOptions {
  readonly port: number
  readonly hostname?: string
  /** The scheme `Request.url` carries. `"https"` by default when {@link tls} is set, else `"http"`. */
  readonly protocol?: "http" | "https"
  /** In-process TLS, inline PEM or file names. */
  readonly tls?: TlsOptions
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
   * defaults; an object sets the settings it advertises. WebSocket upgrades are not served over HTTP/2.
   */
  readonly http2?: boolean | Http2Options
  /**
   * Largest WebSocket message the engine accepts before it fails the connection with 1009. Defaults to
   * the largest `wsMaxPayloadBytes` among the app and the apps mounted in it that serve sockets (a
   * route whose app declares less is held to its own), else the engine's 16 MiB.
   */
  readonly wsMaxMessageSize?: number
  /** Any other engine limit or timeout, passed through as given. */
  readonly engine?: EngineTuning
  /** SIGTERM/SIGINT call `stop()`; off by default, as in `@nifrajs/node`. */
  readonly gracefulSignals?: boolean | NodeStopOptions
}

export interface EngineServer {
  /** The bound port (resolved when `port: 0` is requested). */
  readonly port: number
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
