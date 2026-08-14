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
 * unless `forwardClientIp: true`, in which case the caller chain is appended truthfully. Upstream
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
}

/**
 * How the forwarded request reaches the upstream. Defaults to `fetch`.
 *
 * A transport is a security boundary, and swapping it moves three of this package's guarantees into
 * your implementation. It MUST dial exactly `target` and nothing else, MUST NOT follow redirects
 * (relay the 3xx as-is), and MUST leave TLS verification on. It MUST NOT add, drop, or rewrite the
 * headers it is handed - they have already been sanitised, and re-adding `host` or a forwarding
 * header undoes that work.
 *
 * `@nifrajs/proxy/undici` ships one that satisfies all of this and is substantially faster than
 * `fetch` on Node.
 */
export type ProxyTransport = (
  target: URL,
  request: ProxyUpstreamRequest,
) => Promise<ProxyUpstreamResponse>

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
   * are stripped, so a client-forged chain never reaches the upstream. When true, the inbound
   * `X-Forwarded-For` is kept with the observed caller IP appended (pass a `ProxyContext` so
   * `c.clientIp` - already filtered by the app's trust declaration - is what gets appended). With a
   * bare `Request`, forwarding metadata is suppressed rather than passed through.
   */
  readonly forwardClientIp?: boolean
  /**
   * Deadline in milliseconds for the upstream to *begin* answering. Default `30_000`; expiry
   * answers `504`. It covers up to the response headers, which is the only window in which a `504`
   * is still sendable - once the status has been relayed the exchange cannot be turned into one. A
   * body that starts and then stalls is the transport's timeout to enforce (undici's `bodyTimeout`,
   * for instance); caller disconnect still tears the upstream down at any point.
   */
  readonly timeoutMs?: number
  /** Static headers to set on every forwarded request (after hygiene, so they always win). */
  readonly headers?: Readonly<Record<string, string>>
  /**
   * How to reach the upstream. Defaults to `fetch`. See {@link ProxyTransport} - a transport
   * carries security obligations. `@nifrajs/proxy/undici` is the fast path on Node.
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

/** Forwarding metadata is an explicit opt-in (`forwardClientIp`), never a passthrough. */
const FORWARDING: ReadonlySet<string> = new Set([
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
])

const EMPTY: ReadonlySet<string> = new Set()

/** Header names nominated hop-by-hop by a `Connection` header (lowercased). */
function connectionNominated(headers: Headers): ReadonlySet<string> {
  const raw = headers.get("connection")
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
  const nominated = connectionNominated(req.headers)
  const out = new Headers()
  for (const [name, value] of req.headers) {
    // `host` names the proxy, not the upstream - fetch derives the right one from the target URL.
    if (name === "host" || dropHeader(name, nominated)) continue
    if (FORWARDING.has(name)) continue
    out.append(name, value)
  }
  if (options.forwardClientIp === true && clientIp !== undefined) {
    const prior = req.headers.get("x-forwarded-for")
    const chain = prior !== null ? `${prior}, ${clientIp}` : clientIp
    if (chain !== undefined) out.set("x-forwarded-for", chain)
    out.set("x-forwarded-proto", new URL(req.url).protocol.slice(0, -1))
    const host = req.headers.get("host")
    if (host !== null) out.set("x-forwarded-host", host)
  }
  if (options.headers !== undefined) {
    for (const [name, value] of Object.entries(options.headers)) out.set(name, value)
  }
  return out
}

function relayedResponseHeaders(upstreamHeaders: Headers): Headers {
  const nominated = connectionNominated(upstreamHeaders)
  const out = new Headers()
  for (const [name, value] of upstreamHeaders) {
    if (dropHeader(name, nominated)) continue
    // fetch() already decoded the body per Content-Encoding, so the stored encoding and length no
    // longer describe the bytes being relayed. (Re-compression is the compression() middleware's job.)
    if (name === "content-encoding" || name === "content-length") continue
    // Re-added below via getSetCookie() so multiple cookies survive on every runtime.
    if (name === "set-cookie") continue
    out.append(name, value)
  }
  for (const cookie of upstreamHeaders.getSetCookie()) out.append("set-cookie", cookie)
  return out
}

/**
 * Default transport. `redirect: "manual"` is not a preference - following an upstream redirect
 * would let the upstream choose the proxy's next destination, so it is pinned here and a 3xx is
 * relayed to the caller untouched.
 */
const fetchTransport: ProxyTransport = async (target, request) => {
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
  return {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    body: response.body,
  }
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
  const transport = options.transport ?? fetchTransport

  return async (input) => {
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
    // upstream stream down.
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    if (callerSignal !== undefined) {
      if (callerSignal.aborted) {
        clearTimeout(timer)
        controller.abort()
      } else {
        callerSignal.addEventListener("abort", () => controller.abort(), { once: true })
      }
    }

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
      if (timedOut) return flatError(504, "gateway_timeout")
      if (callerSignal?.aborted === true) throw error
      return flatError(502, "bad_gateway")
    }
    clearTimeout(timer)
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: relayedResponseHeaders(upstream.headers),
    })
  }
}
