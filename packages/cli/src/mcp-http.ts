/**
 * The PUBLIC nifra docs MCP — Streamable-HTTP transport exposing the project-INDEPENDENT tools
 * (`nifra_docs` + `nifra_example`) so any remote AI agent can learn nifra without a local checkout.
 * Both tools read the bundled corpus (llms-full.txt / examples.json shipped in this package) and ignore
 * `cwd`, so they reuse the exact definitions from {@link projectTools} — one source, no drift.
 *
 * {@link handleMcpHttp} is a plain Web `fetch` handler, so it self-hosts ANYWHERE Bun runs — the
 * simplest path is `nifra docs-mcp` on a VPS behind a reverse proxy (Caddy/nginx + TLS), where the
 * bundled corpus reads straight from disk (`Bun.file`). `export default { port, fetch }` also lets
 * `bun run mcp-http.ts` serve it directly, and the same handler runs on Cloudflare/Vercel edge — only
 * there must you inline the two corpus files as string imports (a Worker has no filesystem). The
 * dispatch is the shared, transport-agnostic {@link handleRpc}.
 */

import { loadDocsCorpus } from "./docs-search.ts"
import { loadExamplesCorpus } from "./examples.ts"
import { docsTools } from "./mcp-docs-tools.ts"
import { handleRpc, type JsonRpcRequest, type McpTool, rpcError } from "./mcp-protocol.ts"

export type { Example } from "./examples.ts"
// Re-exported so a self-host (e.g. a Cloudflare-Pages `/mcp` worker route) gets the corpus-injectable
// tool factory + the transport core from one entry: `import { respondMcpHttp, docsTools } from "@nifrajs/cli/mcp"`.
export { docsTools } from "./mcp-docs-tools.ts"

// Kept in lockstep with packages/cli/package.json by check:publish's version-consistency gate.
const VERSION = "0.1.0-beta.1"
const SERVER_INFO = { name: "nifra-docs", version: VERSION }

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

/** The two project-independent tools, reading the package's bundled corpus from disk (CLI use). */
export function publicDocsTools(): McpTool[] {
  return docsTools(loadDocsCorpus, loadExamplesCorpus)
}

/**
 * The transport core, shared by every HTTP host (CLI `docs-mcp`, the site's edge worker): handle one
 * MCP request against the given `tools`. POST a JSON-RPC body → JSON-RPC response; GET is a health page;
 * OPTIONS is the CORS preflight. Never throws — a bad body becomes a JSON-RPC parse error. Pass the
 * tools so each host supplies its own corpus source (disk vs cached fetch) behind identical defs.
 */
export async function respondMcpHttp(
  request: Request,
  tools: McpTool[],
  options: McpHttpOptions = {},
): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS })
  if (request.method === "GET") {
    return new Response(
      "nifra docs MCP — POST JSON-RPC 2.0 here (methods: initialize, tools/list, tools/call). Tools: nifra_docs, nifra_example.",
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
  const response = await handleRpc(message, tools, SERVER_INFO, {}, { signal: request.signal })
  // A notification (no id) yields null — acknowledge with 204, no body.
  if (response === null) return new Response(null, { status: 204, headers: CORS })
  return Response.json(response, { headers: CORS })
}

/** The CLI HTTP handler: serves the disk-backed corpus tools. (`nifra docs-mcp` / `bun run` this file.) */
export function handleMcpHttp(request: Request): Promise<Response> {
  return respondMcpHttp(request, publicDocsTools())
}

/**
 * Worker/edge + local entry. `export default { fetch }` is the universal server shape: Cloudflare /
 * Vercel edge / Deno deploy use `fetch` (and ignore `port`); `bun run mcp-http.ts` auto-serves it on
 * `port` (PORT env, default 8787) — Bun serves a module's default-exported server, so NO manual
 * `Bun.serve` here (that would double-bind the port).
 */
export default {
  port: typeof Bun !== "undefined" ? Number(Bun.env.PORT ?? 8787) : 8787,
  fetch: handleMcpHttp,
}
