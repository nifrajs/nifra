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
  /** Upstream response deadline in milliseconds. Default `30_000`; expiry answers `504`. */
  readonly timeoutMs?: number
  /** Static headers to set on every forwarded request (after hygiene, so they always win). */
  readonly headers?: Readonly<Record<string, string>>
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

function relayedResponseHeaders(upstream: Response): Headers {
  const nominated = connectionNominated(upstream.headers)
  const out = new Headers()
  for (const [name, value] of upstream.headers) {
    if (dropHeader(name, nominated)) continue
    // fetch() already decoded the body per Content-Encoding, so the stored encoding and length no
    // longer describe the bytes being relayed. (Re-compression is the compression() middleware's job.)
    if (name === "content-encoding" || name === "content-length") continue
    // Re-added below via getSetCookie() so multiple cookies survive on every runtime.
    if (name === "set-cookie") continue
    out.append(name, value)
  }
  for (const cookie of upstream.headers.getSetCookie()) out.append("set-cookie", cookie)
  return out
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

  return async (input) => {
    const req = input instanceof Request ? input : input.req
    const clientIp = input instanceof Request ? undefined : input.clientIp
    const callerSignal =
      input instanceof Request ? input.signal : (input.signal ?? input.req.signal)

    const incoming = new URL(req.url)
    let path = incoming.pathname
    if (stripPrefix !== undefined && path.startsWith(stripPrefix)) {
      const rest = path.slice(stripPrefix.length)
      path = rest === "" || !rest.startsWith("/") ? `/${rest}` : rest
    }
    // Mutating a clone of the configured origin - never URL-resolving a request-derived string -
    // means no path (e.g. `//evil.example/x`) can change the host being dialed.
    const target = new URL(base)
    target.pathname = path
    target.search = incoming.search

    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = callerSignal !== undefined ? AbortSignal.any([timeout, callerSignal]) : timeout
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : req.body
    const init: RequestInit & { duplex?: "half" } = {
      method: req.method,
      headers: upstreamRequestHeaders(req, clientIp, options),
      redirect: "manual",
      signal,
    }
    if (body !== null && body !== undefined) {
      init.body = body
      init.duplex = "half"
    }

    let upstream: Response
    try {
      upstream = await fetch(target, init)
    } catch (error) {
      if (timeout.aborted) return flatError(504, "gateway_timeout")
      if (callerSignal?.aborted === true) throw error
      return flatError(502, "bad_gateway")
    }
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: relayedResponseHeaders(upstream),
    })
  }
}
