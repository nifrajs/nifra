/**
 * Reverse proxy to ONE fixed upstream origin, secure by construction.
 *
 * The upstream is a bare origin declared at construction; the forwarded URL is built by *mutating a
 * clone of that origin's path and query*, never by URL-resolving request-derived strings - so no
 * request input (protocol-relative `//host` paths included) can change which host is dialed. SSRF
 * through this proxy is unrepresentable, not filtered.
 *
 * Hop-by-hop hygiene runs in BOTH directions: the RFC 9110 hop-by-hop set, every header nominated
 * by a `Connection` header, and `Proxy-*` headers are dropped from the forwarded request and from
 * the relayed response (the Connection-nominated leak is the @fastify/http-proxy CVE-2026-33805 /
 * Hono proxy CVE-2026-71849 class). Forwarding metadata (`Forwarded`, `X-Forwarded-*`) is stripped
 * unless explicitly configured. `forwardClientIp: true` emits caller IP/protocol, while
 * `forwardedHost` emits only its fixed authority and never the inbound Host. An inbound IP chain is
 * preserved only with the explicit `trustForwardedFor: true` declaration. Upstream
 * redirects are never followed (`redirect: "manual"`) - following one would let the upstream steer
 * the proxy anywhere. TLS verification is always on; there is no knob to disable it.
 */

/** Structural slice of a nifra `Context` the proxy reads - a plain `Request` works too. */
export interface ProxyContext {
  readonly req: Request
  readonly clientIp?: string | undefined
  readonly signal?: AbortSignal | undefined
}

/** The forwarded request, after hygiene, as handed to a {@link ProxyTransport}. */
export interface ProxyUpstreamRequest {
  readonly method: string
  /** Already sanitised: hop-by-hop, Connection-nominated, `Proxy-*`, `host`, and (unless opted in)
   *  forwarding headers are gone, and static `headers` have been applied. Send them as given. */
  readonly headers: Headers
  readonly body: ReadableStream<Uint8Array> | null
  /** Aborts on the deadline or on caller disconnect. A transport MUST honour it. */
  readonly signal: AbortSignal
}

/** What a {@link ProxyTransport} returns. Header hygiene on the way back is the proxy's job. */
export interface ProxyUpstreamResponse {
  readonly status: number
  /** Empty string is fine - HTTP/2 has no reason phrase, and nothing downstream depends on it. */
  readonly statusText: string
  readonly headers: Headers
  readonly body: ReadableStream<Uint8Array> | null
  /**
   * Whether `body` is still exactly the bytes the upstream sent, `Content-Encoding` intact. `fetch`
   * transparently decodes a compressed response, so its body is identity and the stored
   * `content-encoding`/`content-length` no longer describe it - both are dropped on relay (the
   * default when this is omitted). A transport that does NOT decode (undici's `request` does not)
   * MUST set this `true` so the encoding and length are relayed instead, letting the client decode
   * the bytes it actually receives. Getting this wrong ships a gzip body labelled identity.
   */
  readonly bodyEncoded?: boolean
}

/**
 * How the forwarded request reaches the upstream. Defaults to the undici transport on Node when
 * `undici` is installed (substantially faster there), and to `fetch` everywhere else.
 *
 * A transport is a security boundary, and swapping it moves three of this package's guarantees into
 * your implementation. It MUST dial exactly `target` and nothing else, MUST NOT follow redirects
 * (relay the 3xx as-is), and MUST leave TLS verification on. It MUST NOT add, drop, or rewrite the
 * headers it is handed - they have already been sanitised, and re-adding `host` or a forwarding
 * header undoes that work. If it does not decode `Content-Encoding`, it MUST set
 * {@link ProxyUpstreamResponse.bodyEncoded} so the encoding is relayed rather than stripped.
 *
 * `@nifrajs/proxy/undici` ships the one selected by default on Node.
 */
export type ProxyTransport = (
  target: URL,
  request: ProxyUpstreamRequest,
) => Promise<ProxyUpstreamResponse>

/** Structural request view used only by the Node-native mount seam. The raw body stays the
 * IncomingMessage; no Web Request, Headers, or Web stream is created before the transport sees it. */
export interface NodeNativeProxyRequest {
  readonly method: string
  /** Absolute URL assembled by the Node adapter from its trusted protocol/host policy. */
  readonly url: string
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>
  readonly raw: unknown
}

/** Structural response view used by the Node-native mount seam. */
export interface NodeNativeProxyResponse {
  readonly destroyed?: boolean
  readonly writableEnded?: boolean
  readonly writable?: boolean
  readonly headersSent?: boolean
  setHeader(name: string, value: string | readonly string[]): void
  writeHead(status: number): void
  end(body?: string | Uint8Array): void
  once(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown
  destroy(error?: unknown): unknown
}

export interface NativeProxyTransportRequest {
  readonly method: string
  /** Flat name/value pairs already sanitized by the proxy. */
  readonly headers: readonly string[]
  readonly body: unknown
  readonly signal: AbortSignal
  readonly headersTimeout: number
}

export interface NativeProxyUpstreamResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>
  readonly body: unknown
  dump(): Promise<void>
}

export type NativeProxyTransport = (
  target: URL,
  request: NativeProxyTransportRequest,
) => Promise<NativeProxyUpstreamResponse>

const NODE_NATIVE_MOUNT = Symbol.for("@nifrajs/core/node-native-mount")
const NODE_NATIVE_TRANSPORT = Symbol.for("@nifrajs/proxy/node-native-transport")

export interface ProxyOptions {
  /**
   * The upstream to forward every request to, as a **bare origin** (`https://api.internal:8443`).
   * A path, query, fragment, or credentials in the URL throws at construction; only `http:` and
   * `https:` are accepted. The forwarded URL is this origin + the incoming path and query.
   */
  readonly upstream: string
  /** Mount prefix to remove from the incoming path before forwarding (`/api` + request
   * `/api/users` → upstream `/users`). A path outside the prefix is forwarded unchanged. */
  readonly stripPrefix?: string
  /**
   * Forward caller metadata upstream. Default **false**: `Forwarded` and `X-Forwarded-*` headers
   * are stripped, so a client-forged chain never reaches the upstream. When true, the observed caller
   * IP replaces inbound `X-Forwarded-For` by default (pass a `ProxyContext` so `c.clientIp` - already
   * filtered by the app's trust declaration - is the value emitted). With a bare `Request`, forwarding
   * metadata is suppressed rather than passed through.
   */
  readonly forwardClientIp?: boolean
  /** Emit a fixed, trusted `X-Forwarded-Host`. The inbound Host is never forwarded: it is
   * attacker-controlled unless an outer adapter has already applied a host policy. */
  readonly forwardedHost?: string
  /**
   * Preserve an inbound `X-Forwarded-For` chain before appending the observed caller IP. Set this only
   * when a proxy you operate has already stripped and rebuilt the inbound chain; otherwise a directly
   * reachable caller can forge the leading entries. Requires `forwardClientIp: true`.
   */
  readonly trustForwardedFor?: boolean
  /**
   * Deadline in milliseconds for the upstream to *begin* answering. Default `30_000`; expiry
   * answers `504`. It covers up to the response headers, which is the only window in which a `504`
   * is still sendable - once the status has been relayed the exchange cannot be turned into one. A
   * body that starts and then stalls is the transport's timeout to enforce; both built-in transports
   * cap the idle gap between chunks at 30s (undici's `bodyTimeout`, and an equivalent per-chunk timer
   * on the portable one) and error the relayed stream past it. A custom transport owes the same
   * bound. Caller disconnect still tears the upstream down at any point.
   */
  readonly timeoutMs?: number
  /** Static headers to set on every forwarded request (after hygiene, so they always win). */
  readonly headers?: Readonly<Record<string, string>>
  /**
   * How to reach the upstream. Omit to use the default: the undici transport on Node when `undici`
   * is installed (the fast path there, resolved lazily so the base package stays dependency-free),
   * `fetch` on every other runtime and when `undici` is absent. See {@link ProxyTransport} - a
   * transport carries security obligations. Pass one explicitly to pin the choice or tune it (e.g.
   * `undiciTransport({ dispatcher })`).
   */
  readonly transport?: ProxyTransport
}

/** Forward a request (or a nifra context) to the configured upstream. */
export type ProxyHandler = (input: Request | ProxyContext) => Promise<Response>

/** RFC 9110 hop-by-hop headers: they describe one connection, never end-to-end semantics. */
const HOP_BY_HOP: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

/** Forwarding metadata is an explicit opt-in (`forwardClientIp` / `forwardedHost`), never passthrough. */
const FORWARDING: ReadonlySet<string> = new Set([
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
])

const EMPTY: ReadonlySet<string> = new Set()

/**
 * Header names nominated hop-by-hop by a `Connection` header value (lowercased).
 *
 * Takes the raw value, not a header container, so the Web lane (`Headers`) and the Node-native lane
 * (a header record) resolve `connection` their own way and share this one parse - the hop-by-hop
 * decision is security-critical and must not exist in two copies that can drift.
 */
function parseConnectionNominated(raw: string | null): ReadonlySet<string> {
  if (raw === null) return EMPTY
  const out = new Set<string>()
  for (const token of raw.split(",")) {
    const name = token.trim().toLowerCase()
    if (name !== "") out.add(name)
  }
  return out
}

function dropHeader(name: string, nominated: ReadonlySet<string>): boolean {
  return HOP_BY_HOP.has(name) || nominated.has(name) || name.startsWith("proxy-")
}

/**
 * A request header dropped before the hop: it names the proxy (`host`, which the transport derives
 * from the target), is hop-by-hop / Connection-nominated / `proxy-*`, or is forwarding metadata that
 * only explicit proxy options may reintroduce. The single predicate both lanes filter through.
 */
function isDroppedRequestHeader(name: string, nominated: ReadonlySet<string>): boolean {
  return name === "host" || dropHeader(name, nominated) || FORWARDING.has(name)
}

/**
 * A response header kept on relay. Drops hop-by-hop / Connection-nominated, and - only when the
 * transport decoded the body, so the stored `Content-Encoding` and length describe bytes the client
 * will never see - drops those two as well. The undici lanes pass bytes through untouched
 * (`bodyEncoded` true) and keep them; the `fetch` lane decoded and drops them.
 */
function isKeptResponseHeader(
  name: string,
  nominated: ReadonlySet<string>,
  bodyEncoded: boolean,
): boolean {
  if (dropHeader(name, nominated)) return false
  if (!bodyEncoded && (name === "content-encoding" || name === "content-length")) return false
  return true
}

/**
 * The caller-IP `x-forwarded-*` overrides to SET when `forwardClientIp` is on. Shared so the trust
 * decision - the one place that may preserve inbound `x-forwarded-for` - cannot diverge between lanes.
 * Host is intentionally absent: only the fixed `forwardedHost` option may emit it.
 */
function forwardedClientHeaders(
  priorXff: string | null,
  requestUrl: string,
  clientIp: string,
  trustInbound: boolean,
): Array<[string, string]> {
  return [
    ["x-forwarded-for", trustInbound && priorXff !== null ? `${priorXff}, ${clientIp}` : clientIp],
    ["x-forwarded-proto", new URL(requestUrl).protocol.slice(0, -1)],
  ]
}

const flatError = (status: number, error: string): Response =>
  new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { "content-type": "application/json" },
  })

function upstreamRequestHeaders(
  req: Request,
  clientIp: string | undefined,
  options: ProxyOptions,
): Headers {
  const nominated = parseConnectionNominated(req.headers.get("connection"))
  const out = new Headers()
  for (const [name, value] of req.headers) {
    if (isDroppedRequestHeader(name, nominated)) continue
    out.append(name, value)
  }
  if (options.forwardClientIp === true && clientIp !== undefined) {
    for (const [name, value] of forwardedClientHeaders(
      req.headers.get("x-forwarded-for"),
      req.url,
      clientIp,
      options.trustForwardedFor === true,
    )) {
      out.set(name, value)
    }
  }
  if (options.forwardedHost !== undefined) out.set("x-forwarded-host", options.forwardedHost)
  if (options.headers !== undefined) {
    for (const [name, value] of Object.entries(options.headers)) out.set(name, value)
  }
  return out
}

function relayedResponseHeaders(upstreamHeaders: Headers, bodyEncoded: boolean): Headers {
  const nominated = parseConnectionNominated(upstreamHeaders.get("connection"))
  const out = new Headers()
  for (const [name, value] of upstreamHeaders) {
    // Re-added below via getSetCookie() so multiple cookies survive on every runtime - a `Headers`
    // iteration would hand back one comma-joined value that no longer parses as separate cookies.
    if (name === "set-cookie") continue
    if (!isKeptResponseHeader(name, nominated, bodyEncoded)) continue
    out.append(name, value)
  }
  for (const cookie of upstreamHeaders.getSetCookie()) out.append("set-cookie", cookie)
  return out
}

/** Options for {@link fetchTransport}. */
export interface FetchTransportOptions {
  /**
   * Milliseconds of silence tolerated *within* the response body before the relayed stream is
   * errored and the upstream read cancelled. `createProxy`'s own `timeoutMs` only covers the wait
   * for response headers - after the status is relayed a `504` is no longer sendable - so this is
   * what protects against a body that starts and then stalls. Default `30_000` (undici's
   * `bodyTimeout` default, so the choice of transport does not change the bound); `0` disables it.
   */
  readonly bodyTimeoutMs?: number
}

/**
 * Bound the gap *between* response body chunks. `timeoutMs` only covers up to the response headers -
 * the sole window a 504 is still sendable - and `fetch` has no body-side deadline of its own, so an
 * upstream that answers and then stops sending would otherwise pin the caller's connection and this
 * proxy's socket open indefinitely. The timer is armed per read and cleared the moment bytes land,
 * so a healthy stream pays one setTimeout/clearTimeout pair per chunk and nothing else. On expiry
 * the upstream read is cancelled and the relayed stream errors, which is the only signal left once
 * the status line has already been sent.
 */
function idleBoundedBody<T>(body: ReadableStream<T>, ms: number): ReadableStream<T> {
  const reader = body.getReader()
  let timer: ReturnType<typeof setTimeout> | undefined
  const disarm = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }
  return new ReadableStream<T>({
    async pull(controller) {
      // Rejects only while the read below is still outstanding: `disarm()` runs before this pull
      // settles either way, so the timer can never fire against an already-answered read and leave
      // an unobserved rejection behind.
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`[nifra/proxy] upstream response body stalled for ${ms}ms`))
        }, ms)
      })
      try {
        const result = await Promise.race([reader.read(), stalled])
        if (result.done) {
          controller.close()
          return
        }
        controller.enqueue(result.value)
      } catch (error) {
        // Tear the upstream down as well - erroring only the relayed stream would leave the
        // upstream socket reading into nothing.
        void reader.cancel(error).catch(() => {})
        throw error
      } finally {
        disarm()
      }
    },
    cancel(reason) {
      disarm()
      return reader.cancel(reason)
    },
  })
}

/**
 * The Node-stream claim seam, by value rather than by import: `node-stream.ts` pulls `node:stream`,
 * and this file has to stay loadable on every runtime. Only the key and the shape below are the
 * contract - see that module for what claiming means and why it is one-shot.
 */
const NODE_STREAM_CLAIM = Symbol.for("nifra.node.stream-claim")

/** The part of the claim holder this file touches; the claimed value is a Node `Readable`. */
interface StreamClaimHolder {
  claim(): { once(event: string, listener: () => void): unknown } | null
}

/**
 * Run `onSettled` once the relayed body is finished with - closed, errored, or cancelled.
 *
 * A body that arrives claimable (the undici transport hands the upstream's Node stream through a Web
 * view that `@nifrajs/node` can trade back in) keeps its claim: the wrapper forwards it, and when the
 * claim is taken the callback moves to the Node stream's `close` instead. Replacing the stream
 * outright would strip the claim and put every proxied byte back through a Web round trip.
 *
 * `highWaterMark: 0` for the same reason it is zero in `claimableWebStream`: a default strategy pulls
 * speculatively at construction, which would read the source before anyone asked and make the claim
 * unavailable in every case.
 */
function settleTracked(
  body: ReadableStream<Uint8Array>,
  onSettled: () => void,
): ReadableStream<Uint8Array> {
  let settled = false
  const settle = (): void => {
    if (settled) return
    settled = true
    onSettled()
  }
  const reader = body.getReader()
  const tracked = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const result = await reader.read()
          if (result.done) {
            controller.close()
            settle()
            return
          }
          controller.enqueue(result.value)
        } catch (error) {
          settle()
          throw error
        }
      },
      cancel(reason) {
        settle()
        return reader.cancel(reason)
      },
    },
    { highWaterMark: 0 },
  )
  const holder = (body as { readonly [NODE_STREAM_CLAIM]?: StreamClaimHolder })[NODE_STREAM_CLAIM]
  if (holder !== undefined && typeof holder.claim === "function") {
    const forwarded: StreamClaimHolder = {
      claim() {
        const claimed = holder.claim()
        if (claimed === null) return null
        // The wrapper is bypassed from here on, so the Node stream's own end is the settle point.
        claimed.once("close", settle)
        return claimed
      },
    }
    Object.defineProperty(tracked, NODE_STREAM_CLAIM, { value: forwarded, enumerable: false })
  }
  return tracked
}

/**
 * Create the portable `fetch`-backed {@link ProxyTransport} - the default off Node, and the fallback
 * everywhere the undici transport cannot be used. `redirect: "manual"` is not a preference: following
 * an upstream redirect would let the upstream choose the proxy's next destination, so it is pinned
 * here and a 3xx is relayed to the caller untouched.
 *
 * Pass it explicitly only to tune {@link FetchTransportOptions.bodyTimeoutMs} or to pin the choice
 * on Node; leaving `transport` unset picks the right one per runtime.
 */
export function fetchTransport(options: FetchTransportOptions = {}): ProxyTransport {
  const bodyTimeout = options.bodyTimeoutMs ?? 30_000
  if (!Number.isFinite(bodyTimeout) || bodyTimeout < 0) {
    throw new Error("[nifra/proxy] bodyTimeoutMs must be a non-negative number")
  }
  return async (target, request) => {
    const init: RequestInit & { duplex?: "half" } = {
      method: request.method,
      headers: request.headers,
      redirect: "manual",
      signal: request.signal,
    }
    if (request.body !== null) {
      init.body = request.body
      init.duplex = "half"
    }
    const response = await fetch(target, init)
    const body = response.body
    return {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body: body === null || bodyTimeout === 0 ? body : idleBoundedBody(body, bodyTimeout),
      // fetch decoded any Content-Encoding, so the relayed body is identity.
      bodyEncoded: false,
    }
  }
}

/** The portable transport with its defaults - built once, not per request. */
const defaultFetchTransport = fetchTransport()

/**
 * Pick the transport when the caller named none. On Node, `undici`'s dispatcher is ~2.5x `fetch` on
 * GET and ~2.2x on POST for this workload, so it is the default there when installed - resolved
 * lazily through a dynamic `import` so the base package keeps no static dependency on `undici` and
 * stays loadable on runtimes that do not ship it. Everywhere else `fetch` is both the portable
 * choice and the fast one: under Bun the `undici` specifier is a shim `undiciTransport` refuses, and
 * Bun/Deno/edge `fetch` already measures level with a raw client. A Node install without the
 * optional `undici` peer falls back to `fetch` rather than failing.
 */
async function selectDefaultTransport(): Promise<ProxyTransport> {
  const runtime = globalThis as { readonly Bun?: unknown; readonly Deno?: unknown }
  const onNode =
    runtime.Bun === undefined &&
    runtime.Deno === undefined &&
    typeof process !== "undefined" &&
    process.versions?.node !== undefined
  if (!onNode) return defaultFetchTransport
  try {
    // The specifier is a variable, not a literal, on purpose: a bundler targeting an edge runtime
    // must NOT follow this into `undici` (which pulls `node:*` builtins), and this branch only ever
    // executes on Node. `import()` of a non-literal is left as a genuine runtime import, so `undici`
    // enters the graph only for a Node consumer that actually reaches here. The `.js` names the
    // emitted file directly (tsc does not resolve a variable specifier); the cast restores its type.
    const undiciModule = "./undici.js"
    const mod = (await import(undiciModule)) as typeof import("./undici.ts")
    return mod.undiciTransport()
  } catch {
    // `undici` is an optional peer - absent, we simply keep the portable transport.
    return defaultFetchTransport
  }
}

function nativeTransportOf(value: unknown): NativeProxyTransport | undefined {
  if (typeof value !== "function") return undefined
  const candidate = (value as unknown as Record<symbol, unknown>)[NODE_NATIVE_TRANSPORT]
  return typeof candidate === "function" ? (candidate as NativeProxyTransport) : undefined
}

/** Load the optional client directly for a bundled Node consumer. A variable specifier keeps
 * `undici` out of edge bundles; unlike a relative dynamic import, Node-targeted single-file bundlers
 * leave this as the real package lookup rather than emitting a sibling `undici.js` that does not
 * exist next to the one-file application bundle. */
async function defaultNativeTransport(): Promise<NativeProxyTransport | undefined> {
  try {
    const packageName = "undici"
    const mod = (await import(packageName)) as {
      readonly request?: (
        target: URL,
        options: {
          readonly method: string
          readonly headers: string[]
          readonly body: unknown
          readonly signal: AbortSignal
          readonly headersTimeout: number
          readonly bodyTimeout: number
        },
      ) => Promise<{
        readonly statusCode: number
        readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>
        readonly body: {
          dump(): Promise<void>
        }
      }>
    }
    if (typeof mod.request !== "function") return undefined
    const request = mod.request
    return async (target, input) => {
      const upstream = await request(target, {
        method: input.method,
        headers: Array.from(input.headers),
        body: input.body,
        signal: input.signal,
        headersTimeout: input.headersTimeout,
        bodyTimeout: 30_000,
      })
      return {
        status: upstream.statusCode,
        headers: upstream.headers,
        body: upstream.body,
        dump: () => upstream.body.dump(),
      }
    }
  } catch {
    return undefined
  }
}

function nativeHeaderValue(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  name: string,
): string | null {
  const value = headers[name]
  if (value === undefined) return null
  return typeof value === "string" ? value : Array.from(value).join(", ")
}

function nativeHeaderValues(value: string | readonly string[] | undefined): readonly string[] {
  if (value === undefined) return []
  return typeof value === "string" ? [value] : value
}

function nativeRequestHeaders(
  request: NodeNativeProxyRequest,
  clientIp: string | undefined,
  options: ProxyOptions,
): string[] {
  const nominated = parseConnectionNominated(nativeHeaderValue(request.headers, "connection"))
  const entries: string[] = []
  for (const [name, raw] of Object.entries(request.headers)) {
    if (raw === undefined) continue
    if (isDroppedRequestHeader(name, nominated)) continue
    for (const value of nativeHeaderValues(raw)) entries.push(name, value)
  }
  const replace = (name: string, value: string): void => {
    for (let i = entries.length - 2; i >= 0; i -= 2) {
      if (entries[i] === name) entries.splice(i, 2)
    }
    entries.push(name, value)
  }
  if (options.forwardClientIp === true && clientIp !== undefined) {
    for (const [name, value] of forwardedClientHeaders(
      nativeHeaderValue(request.headers, "x-forwarded-for"),
      request.url,
      clientIp,
      options.trustForwardedFor === true,
    )) {
      replace(name, value)
    }
  }
  if (options.forwardedHost !== undefined) replace("x-forwarded-host", options.forwardedHost)
  if (options.headers !== undefined) {
    for (const [name, value] of Object.entries(options.headers)) replace(name.toLowerCase(), value)
  }
  return entries
}

function nativeResponseHeaders(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
): Array<[string, string | readonly string[]]> {
  const nominated = parseConnectionNominated(nativeHeaderValue(headers, "connection"))
  const out: Array<[string, string | readonly string[]]> = []
  for (const [name, value] of Object.entries(headers)) {
    // The native lane is always the undici passthrough transport, which does not decode the body,
    // so the stored content-encoding/length still describe the relayed bytes: `bodyEncoded` true.
    if (value === undefined || !isKeptResponseHeader(name, nominated, true)) continue
    out.push([name, value])
  }
  return out
}

interface NativeBodyStream {
  readonly destroyed?: boolean
  on(event: string, listener: (...args: unknown[]) => void): unknown
  once(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown
  destroy(error?: unknown): unknown
  pipe(destination: unknown): unknown
}

function nativeResponseOpen(response: NodeNativeProxyResponse): boolean {
  return (
    response.destroyed !== true && response.writableEnded !== true && response.writable !== false
  )
}

function nativeFlatError(
  response: NodeNativeProxyResponse,
  statusCode: number,
  error: string,
): void {
  if (!nativeResponseOpen(response)) return
  const body = JSON.stringify({ ok: false, error })
  response.setHeader("content-type", "application/json")
  response.setHeader("content-length", String(new TextEncoder().encode(body).byteLength))
  response.writeHead(statusCode)
  response.end(body)
}

function pipeNativeBody(
  body: NativeBodyStream,
  response: NodeNativeProxyResponse,
  cleanup: () => void,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      response.removeListener("close", onClose)
      response.removeListener("finish", onFinish)
      body.removeListener("error", onError)
      cleanup()
      if (body.destroyed !== true) body.destroy()
      resolve()
    }
    const onClose = (): void => done()
    const onFinish = (): void => done()
    const onError = (): void => {
      if (!settled && nativeResponseOpen(response)) response.destroy()
      done()
    }
    body.on("error", onError)
    response.once("close", onClose)
    response.once("finish", onFinish)
    if (!nativeResponseOpen(response)) {
      done()
      return
    }
    try {
      body.pipe(response)
    } catch {
      onError()
    }
  })
}

/**
 * Create a proxy handler bound to one upstream origin.
 *
 * ```ts
 * const upstream = createProxy({ upstream: "http://127.0.0.1:8081" })
 * app.mountFetch("/api", upstream, { stripPrefix: true })
 * ```
 *
 * Streams both directions, preserves method/path/query/status, strips hop-by-hop and
 * Connection-nominated headers both ways, never follows upstream redirects, and answers flat
 * errors: `502 bad_gateway` when the upstream is unreachable, `504 gateway_timeout` on deadline.
 * WebSocket upgrade is not proxied.
 */
export function createProxy(options: ProxyOptions): ProxyHandler {
  const base = new URL(options.upstream)
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error(`[nifra/proxy] upstream must be http(s), got ${base.protocol}`)
  }
  if (
    base.pathname !== "/" ||
    base.search !== "" ||
    base.hash !== "" ||
    base.username !== "" ||
    base.password !== ""
  ) {
    throw new Error(
      "[nifra/proxy] upstream must be a bare origin (no path, query, fragment, or credentials)",
    )
  }
  const stripPrefix = options.stripPrefix
  if (stripPrefix !== undefined && (!stripPrefix.startsWith("/") || stripPrefix.endsWith("/"))) {
    throw new Error('[nifra/proxy] stripPrefix must start with "/" and not end with one')
  }
  if (options.trustForwardedFor === true && options.forwardClientIp !== true) {
    throw new Error("[nifra/proxy] trustForwardedFor requires forwardClientIp: true")
  }
  if (options.forwardedHost !== undefined) {
    let parsed: URL
    try {
      parsed = new URL(`http://${options.forwardedHost}`)
    } catch {
      throw new TypeError("[nifra/proxy] forwardedHost must be a bare host authority")
    }
    if (
      options.forwardedHost === "" ||
      parsed.host === "" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      /[\r\n\s]/.test(options.forwardedHost)
    ) {
      throw new TypeError("[nifra/proxy] forwardedHost must be a bare host authority")
    }
  }
  const timeoutMs = options.timeoutMs ?? 30_000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("[nifra/proxy] timeoutMs must be a positive number")
  }
  for (const name of Object.keys(options.headers ?? {})) {
    const normalized = name.toLowerCase()
    if (
      normalized === "host" ||
      HOP_BY_HOP.has(normalized) ||
      normalized.startsWith("proxy-") ||
      FORWARDING.has(normalized)
    ) {
      throw new TypeError(`[nifra/proxy] static header is not allowed: ${name}`)
    }
  }
  // An explicit transport is used as given. Otherwise the default is resolved lazily on the first
  // request and memoised: the dynamic `import` of the undici transport cannot run in this synchronous
  // constructor, and doing it per request would re-pay the resolution every time.
  const explicitTransport = options.transport
  let resolvedTransport = explicitTransport
  let resolving: Promise<ProxyTransport> | undefined
  const getTransport = (): ProxyTransport | Promise<ProxyTransport> => {
    if (resolvedTransport !== undefined) return resolvedTransport
    resolving ??= selectDefaultTransport().then((t) => {
      resolvedTransport = t
      return t
    })
    return resolving
  }

  // The native lane is available only for the built-in undici transport. A custom transport keeps
  // the documented Web contract and therefore falls back to the existing path rather than silently
  // bypassing its implementation. The default is resolved lazily for the same optional-peer and
  // edge-bundle reasons as `selectDefaultTransport` above.
  const explicitNativeTransport = nativeTransportOf(explicitTransport)
  let nativeTransport = explicitNativeTransport
  let nativeResolving: Promise<NativeProxyTransport | undefined> | undefined
  const getNativeTransport = ():
    | NativeProxyTransport
    | Promise<NativeProxyTransport | undefined>
    | undefined => {
    if (nativeTransport !== undefined) return nativeTransport
    if (explicitTransport !== undefined) return undefined
    nativeResolving ??= defaultNativeTransport().then((candidate) => {
      nativeTransport = candidate
      return candidate
    })
    return nativeResolving
  }

  const proxy = async (input: Request | ProxyContext): Promise<Response> => {
    const req = input instanceof Request ? input : input.req
    const clientIp = input instanceof Request ? undefined : input.clientIp
    const callerSignal =
      input instanceof Request ? input.signal : (input.signal ?? input.req.signal)

    const incoming = new URL(req.url)
    let path = incoming.pathname
    if (stripPrefix !== undefined && (path === stripPrefix || path.startsWith(`${stripPrefix}/`))) {
      const rest = path.slice(stripPrefix.length)
      path = rest === "" || !rest.startsWith("/") ? `/${rest}` : rest
    }
    // Mutating a clone of the configured origin - never URL-resolving a request-derived string -
    // means no path (e.g. `//evil.example/x`) can change the host being dialed.
    const target = new URL(base)
    target.pathname = path
    target.search = incoming.search

    // One AbortController instead of `AbortSignal.timeout` + `AbortSignal.any`: that pair costs
    // ~12x more per request on Node, and its timer is only reclaimed once GC gets to the signal.
    // Here the timer is cancelled the moment the upstream answers, so a burst of in-flight requests
    // cannot leave a deadline-long backlog of live timers in the wheel. The caller listener
    // deliberately outlives the timer - a client that disconnects mid-body must still tear the
    // upstream stream down - so it is dropped when the exchange ends instead.
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const abortUpstream = (): void => controller.abort()
    // Removing the listener only matters for a signal that outlives this request: `req.signal`
    // belongs to the request and is collected with it, while a caller-supplied `signal` may be
    // shared by every request a process proxies, where one retained listener per exchange
    // accumulates without bound. Only that case pays for the bookkeeping below.
    const sharedSignal = callerSignal !== req.signal
    let releaseCaller = (): void => {}
    if (callerSignal.aborted) {
      clearTimeout(timer)
      controller.abort()
    } else {
      callerSignal.addEventListener("abort", abortUpstream, { once: true })
      if (sharedSignal) {
        releaseCaller = () => {
          callerSignal.removeEventListener("abort", abortUpstream)
        }
      }
    }

    const transport = resolvedTransport ?? (await getTransport())
    let upstream: ProxyUpstreamResponse
    try {
      upstream = await transport(target, {
        method: req.method,
        headers: upstreamRequestHeaders(req, clientIp, options),
        body: req.method === "GET" || req.method === "HEAD" ? null : req.body,
        signal: controller.signal,
      })
    } catch (error) {
      clearTimeout(timer)
      releaseCaller()
      if (timedOut) return flatError(504, "gateway_timeout")
      if (callerSignal.aborted) throw error
      return flatError(502, "bad_gateway")
    }
    clearTimeout(timer)
    const relayed = upstream.body
    if (relayed === null) releaseCaller()
    return new Response(
      relayed !== null && sharedSignal ? settleTracked(relayed, releaseCaller) : relayed,
      {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: relayedResponseHeaders(upstream.headers, upstream.bodyEncoded === true),
      },
    )
  }

  const nativeMount = async (
    input: NodeNativeProxyRequest,
    response: NodeNativeProxyResponse,
    platform?: { readonly clientIp?: string },
  ): Promise<undefined | false> => {
    const transport = await getNativeTransport()
    if (transport === undefined) return false

    const raw = input.raw as {
      readonly destroyed?: boolean
      readonly aborted?: boolean
      once(event: string, listener: (...args: unknown[]) => void): unknown
      removeListener(event: string, listener: (...args: unknown[]) => void): unknown
    }
    const controller = new AbortController()
    let timedOut = false
    let cleaned = false
    const onAbort = (): void => controller.abort()
    const cleanup = (): void => {
      if (cleaned) return
      cleaned = true
      raw.removeListener("aborted", onAbort)
      response.removeListener("close", onAbort)
    }
    raw.once("aborted", onAbort)
    response.once("close", onAbort)
    if (raw.destroyed === true || raw.aborted === true || response.destroyed === true) {
      cleanup()
      return
    }

    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const incoming = new URL(input.url)
    let path = incoming.pathname
    if (stripPrefix !== undefined && (path === stripPrefix || path.startsWith(`${stripPrefix}/`))) {
      const rest = path.slice(stripPrefix.length)
      path = rest === "" || !rest.startsWith("/") ? `/${rest}` : rest
    }
    // As in the Web path, mutate only a clone of the fixed origin. The Node adapter's URL is used
    // for path/query and never as a URL base, so a request path cannot redirect the dialed host.
    const target = new URL(base)
    target.pathname = path
    target.search = incoming.search

    try {
      const upstream = await transport(target, {
        method: input.method,
        headers: nativeRequestHeaders(input, platform?.clientIp, options),
        body: input.method === "GET" || input.method === "HEAD" ? null : input.raw,
        signal: controller.signal,
        headersTimeout: timeoutMs,
      })
      clearTimeout(timer)
      if (controller.signal.aborted) {
        cleanup()
        return
      }
      for (const [name, value] of nativeResponseHeaders(upstream.headers)) {
        response.setHeader(name, value)
      }

      const noBody =
        input.method === "HEAD" ||
        upstream.status === 101 ||
        upstream.status === 204 ||
        upstream.status === 205 ||
        upstream.status === 304
      if (noBody) {
        await upstream.dump()
        if (!nativeResponseOpen(response)) {
          cleanup()
          return
        }
        response.writeHead(upstream.status)
        response.end()
        cleanup()
        return
      }

      if (!nativeResponseOpen(response)) {
        cleanup()
        return
      }
      response.writeHead(upstream.status)
      await pipeNativeBody(upstream.body as NativeBodyStream, response, cleanup)
      return
    } catch {
      clearTimeout(timer)
      cleanup()
      if (controller.signal.aborted && !timedOut) return
      if (timedOut) nativeFlatError(response, 504, "gateway_timeout")
      else nativeFlatError(response, 502, "bad_gateway")
      return
    }
  }

  const runtime = globalThis as { readonly Bun?: unknown; readonly Deno?: unknown }
  const nodeRuntime =
    runtime.Bun === undefined &&
    runtime.Deno === undefined &&
    typeof process !== "undefined" &&
    process.versions?.node !== undefined
  // A caller-supplied transport without the native marker must not pay a promise-based probe on
  // every Node request. The default is advertised on Node and can still fall back once if the
  // optional peer is absent; all other runtimes keep the exact portable mount shape.
  if (explicitNativeTransport !== undefined || (explicitTransport === undefined && nodeRuntime)) {
    Object.defineProperty(proxy, NODE_NATIVE_MOUNT, { value: nativeMount })
  }
  return proxy
}
