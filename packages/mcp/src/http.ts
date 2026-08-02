/**
 * The transport core shared by every HTTP host of an MCP server - the dev/docs MCP in `@nifrajs/cli`
 * (`nifra docs-mcp`), the site's edge worker, and a nifra app mounting `POST /mcp` via
 * {@link ./server.ts}. {@link respondMcpHttp} is a plain Web `fetch` handler: POST a JSON-RPC body →
 * JSON-RPC response; GET is a health page; OPTIONS is the CORS preflight. It never throws - a bad body
 * becomes a JSON-RPC parse error. Pass the tools (and optional {@link McpServerFeatures} for resources /
 * prompts / the MCP Apps `ui://` widgets) so each host supplies its own corpus/source behind one core.
 */

import {
  handleRpc,
  type JsonRpcRequest,
  type JsonRpcResponse,
  MCP_ERROR,
  type McpServerFeatures,
  type McpTool,
  modernVersionOf,
  rpcError,
} from "./protocol.ts"

// Headers on every response. `access-control-allow-headers` lists the request headers a browser MCP client
// (claude.ai, ChatGPT) actually sends: `mcp-protocol-version` (required per POST since 2025-06-18),
// `mcp-method`/`mcp-name` (the 2026-07-28 request-metadata mirror), `authorization` (OAuth-protected hosts),
// plus `accept`/`last-event-id`. Omit any and the CORS preflight fails, so the connector never loads.
const CORS_BASE: Record<string, string> = {
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers":
    "content-type, authorization, mcp-protocol-version, mcp-session-id, mcp-method, mcp-name, accept, last-event-id",
  "access-control-expose-headers": "mcp-protocol-version, mcp-session-id",
  "access-control-max-age": "86400",
}

/**
 * Resolve the CORS/Origin headers for one request against the host's `allowedOrigins` policy, or `null`
 * when the request's `Origin` is present but not allowed - the caller then answers 403, per the
 * Streamable-HTTP DNS-rebinding rule ("Servers MUST validate the `Origin` header ... respond with 403").
 * With no policy (the default) every origin is allowed and reflected as `*` - correct for a public,
 * secret-free, unauthenticated server, whose browser clients send arbitrary origins we can't enumerate.
 */
function corsFor(
  request: Request,
  allowedOrigins: readonly string[] | undefined,
): Record<string, string> | null {
  if (allowedOrigins === undefined) return { ...CORS_BASE, "access-control-allow-origin": "*" }
  const origin = request.headers.get("origin")
  // A caller with no Origin (curl, server-to-server) can't mount a DNS-rebinding attack - allow it.
  if (origin === null) return { ...CORS_BASE, vary: "Origin" }
  if (allowedOrigins.includes(origin)) {
    return { ...CORS_BASE, "access-control-allow-origin": origin, vary: "Origin" }
  }
  return null
}

const DEFAULT_MAX_BODY_BYTES = 1_000_000
const TEXT_DECODER = new TextDecoder()

export interface McpHttpOptions {
  /** Maximum JSON-RPC request body size in bytes. Default 1 MB. */
  readonly maxBodyBytes?: number
  /** Resources / prompts / the MCP Apps UI extension served alongside the tools. */
  readonly features?: McpServerFeatures
  /** Shown on the GET health page so each host can describe itself. */
  readonly health?: string
  /**
   * Origin allowlist for the DNS-rebinding guard. Omit (the default) to allow any origin - the right
   * choice for a public, unauthenticated docs server that can't enumerate its browser clients' origins.
   * Set it (e.g. a localhost origin for a hardened local host) to reject any other browser origin with 403.
   */
  readonly allowedOrigins?: readonly string[]
}

function parseContentLength(value: string): number | undefined {
  if (value.length === 0) return undefined
  let length = 0
  for (let i = 0; i < value.length; i++) {
    const digit = value.charCodeAt(i) - 48
    if (digit < 0 || digit > 9) return undefined
    length = length * 10 + digit
    if (length > Number.MAX_SAFE_INTEGER) return Number.POSITIVE_INFINITY
  }
  return length
}

async function readJsonBounded(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; status: 400 | 413 }> {
  const declared = request.headers.get("content-length")
  if (declared !== null) {
    const length = parseContentLength(declared)
    if (length === undefined) return { ok: false, status: 400 }
    if (length > maxBytes) return { ok: false, status: 413 }
  }

  const body = request.body
  if (body === null) return { ok: false, status: 400 }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      return { ok: false, status: 413 }
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return { ok: true, value: JSON.parse(TEXT_DECODER.decode(bytes)) as unknown }
  } catch {
    return { ok: false, status: 400 }
  }
}

const SENTINEL_PREFIX = "=?base64?"
const SENTINEL_SUFFIX = "?="

/** Decode the Streamable-HTTP `=?base64?...?=` header sentinel (used when a name/uri isn't header-safe).
 * A plain value passes through; a malformed sentinel is returned as-is so validation still fails closed. */
function decodeSentinel(value: string | null): string | null {
  if (value === null) return null
  if (!value.startsWith(SENTINEL_PREFIX) || !value.endsWith(SENTINEL_SUFFIX)) return value
  const encoded = value.slice(SENTINEL_PREFIX.length, value.length - SENTINEL_SUFFIX.length)
  try {
    return TEXT_DECODER.decode(Uint8Array.from(atob(encoded), (ch) => ch.charCodeAt(0)))
  } catch {
    return value
  }
}

/** Validate a modern (2026-07-28) request's mirrored headers against its body: `MCP-Protocol-Version`,
 * `Mcp-Method`, and - for name-bearing methods - `Mcp-Name` MUST match, else a `HeaderMismatch` the caller
 * returns as 400. Stops an intermediary from routing on a header while the server acts on a different body. */
function modernHeaderMismatch(
  request: Request,
  message: JsonRpcRequest,
  bodyVersion: string,
): JsonRpcResponse | null {
  const rid = message.id ?? null
  const headerVersion = request.headers.get("mcp-protocol-version")
  if (headerVersion === null || headerVersion !== bodyVersion) {
    return rpcError(
      rid,
      MCP_ERROR.HEADER_MISMATCH,
      "MCP-Protocol-Version header missing or mismatched",
    )
  }
  const method = typeof message.method === "string" ? message.method : ""
  const headerMethod = request.headers.get("mcp-method")
  if (headerMethod === null || headerMethod !== method) {
    return rpcError(rid, MCP_ERROR.HEADER_MISMATCH, "Mcp-Method header missing or mismatched")
  }
  if (method === "tools/call" || method === "resources/read" || method === "prompts/get") {
    const bodyName = method === "resources/read" ? message.params?.uri : message.params?.name
    const headerName = decodeSentinel(request.headers.get("mcp-name"))
    if (headerName === null || typeof bodyName !== "string" || headerName !== bodyName) {
      return rpcError(rid, MCP_ERROR.HEADER_MISMATCH, "Mcp-Name header missing or mismatched")
    }
  }
  return null
}

/** HTTP status for a modern request's dispatch result: 400 for version/header errors, 404 for an unknown
 * method, 200 otherwise (in-band tool errors are ordinary JSON-RPC results and stay 200). */
function modernErrorStatus(response: JsonRpcResponse): number {
  if (!("error" in response)) return 200
  const { code } = response.error
  if (code === MCP_ERROR.UNSUPPORTED_VERSION || code === MCP_ERROR.HEADER_MISMATCH) return 400
  return code === -32601 ? 404 : 200
}

/**
 * Handle one MCP request over HTTP against the given `tools`/`features`. POST a JSON-RPC body → JSON-RPC
 * response; GET → a plain-text health page; OPTIONS → CORS preflight. Never throws - a bad body becomes a
 * JSON-RPC parse error. Dual-era: a modern (2026-07-28) POST that mirrors its method/name/version into
 * headers is validated against the body before dispatch and gets spec HTTP statuses; legacy requests are
 * served unchanged. The dispatch is the shared, transport-agnostic {@link handleRpc}.
 */
export async function respondMcpHttp(
  request: Request,
  tools: McpTool[],
  serverInfo: { name: string; version: string },
  options: McpHttpOptions = {},
): Promise<Response> {
  const cors = corsFor(request, options.allowedOrigins)
  if (cors === null) {
    // Origin present but not allowlisted: reject before the body is ever read (DNS-rebinding guard). No
    // `id` (no request parsed) and no CORS headers - a disallowed origin gets nothing to work with.
    return Response.json(rpcError(null, -32600, "origin not allowed"), { status: 403 })
  }
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors })
  if (request.method === "GET") {
    // The 2026-07-28 revision removed the GET SSE stream; a client probing for it (`Accept:
    // text/event-stream`) gets 405 so its transport fallback fires. A plain browser/monitor GET still
    // gets the human-readable health page.
    if ((request.headers.get("accept") ?? "").includes("text/event-stream")) {
      return new Response("event stream not supported", {
        status: 405,
        headers: { allow: "POST, GET", ...cors },
      })
    }
    return new Response(
      options.health ??
        "MCP server - POST JSON-RPC 2.0 here (methods: initialize, tools/list, tools/call).",
      { headers: { "content-type": "text/plain; charset=utf-8", ...cors } },
    )
  }
  if (request.method !== "POST") {
    return new Response("method not allowed", {
      status: 405,
      headers: { allow: "POST, GET", ...cors },
    })
  }
  const parsed = await readJsonBounded(request, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES)
  if (!parsed.ok) {
    if (parsed.status === 413) {
      return Response.json(rpcError(null, -32000, "payload too large"), {
        status: 413,
        headers: cors,
      })
    }
    return Response.json(rpcError(null, -32700, "parse error"), { status: 400, headers: cors })
  }
  const message = parsed.value as JsonRpcRequest
  const bodyVersion = modernVersionOf(message.params)
  // Mirror the protocol version back for intermediaries (SHOULD, 2025-06-18+); absent is fine.
  const echoVersion = request.headers.get("mcp-protocol-version")
  const headers = echoVersion !== null ? { ...cors, "mcp-protocol-version": echoVersion } : cors
  if (bodyVersion !== undefined) {
    // Modern request: header/body mirror MUST agree. Reject divergence with 400 before dispatch.
    const headerError = modernHeaderMismatch(request, message, bodyVersion)
    if (headerError !== null) return Response.json(headerError, { status: 400, headers })
  }
  const response = await handleRpc(message, tools, serverInfo, options.features ?? {}, {
    signal: request.signal,
  })
  // A notification (no id) yields null - acknowledge with 202 Accepted and no body (Streamable-HTTP).
  if (response === null) return new Response(null, { status: 202, headers })
  // Modern requests carry spec HTTP statuses (400 version/header, 404 unknown method); legacy stays 200.
  const status = bodyVersion !== undefined ? modernErrorStatus(response) : 200
  return Response.json(response, { status, headers })
}
