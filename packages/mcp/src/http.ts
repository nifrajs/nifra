/**
 * The transport core shared by every HTTP host of an MCP server — the dev/docs MCP in `@nifrajs/cli`
 * (`nifra docs-mcp`), the site's edge worker, and a nifra app mounting `POST /mcp` via
 * {@link ./server.ts}. {@link respondMcpHttp} is a plain Web `fetch` handler: POST a JSON-RPC body →
 * JSON-RPC response; GET is a health page; OPTIONS is the CORS preflight. It never throws — a bad body
 * becomes a JSON-RPC parse error. Pass the tools (and optional {@link McpServerFeatures} for resources /
 * prompts / the MCP Apps `ui://` widgets) so each host supplies its own corpus/source behind one core.
 */

import {
  handleRpc,
  type JsonRpcRequest,
  type McpServerFeatures,
  type McpTool,
  rpcError,
} from "./protocol.ts"

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "content-type",
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

/**
 * Handle one MCP request over HTTP against the given `tools`/`features`. POST a JSON-RPC body → JSON-RPC
 * response; GET → a plain-text health page; OPTIONS → CORS preflight. Never throws — a bad body becomes a
 * JSON-RPC parse error. The dispatch is the shared, transport-agnostic {@link handleRpc}.
 */
export async function respondMcpHttp(
  request: Request,
  tools: McpTool[],
  serverInfo: { name: string; version: string },
  options: McpHttpOptions = {},
): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS })
  if (request.method === "GET") {
    return new Response(
      options.health ??
        "MCP server — POST JSON-RPC 2.0 here (methods: initialize, tools/list, tools/call).",
      { headers: { "content-type": "text/plain; charset=utf-8", ...CORS } },
    )
  }
  if (request.method !== "POST") {
    return new Response("method not allowed", {
      status: 405,
      headers: { allow: "POST, GET", ...CORS },
    })
  }
  const parsed = await readJsonBounded(request, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES)
  if (!parsed.ok) {
    if (parsed.status === 413) {
      return Response.json(rpcError(null, -32000, "payload too large"), {
        status: 413,
        headers: CORS,
      })
    }
    return Response.json(rpcError(null, -32700, "parse error"), { status: 400, headers: CORS })
  }
  const message = parsed.value as JsonRpcRequest
  const response = await handleRpc(message, tools, serverInfo, options.features ?? {}, {
    signal: request.signal,
  })
  // A notification (no id) yields null — acknowledge with 204, no body.
  if (response === null) return new Response(null, { status: 204, headers: CORS })
  return Response.json(response, { headers: CORS })
}
