/**
 * The PUBLIC nifra docs MCP — Streamable-HTTP transport exposing the project-INDEPENDENT tools
 * (`nifra_docs` + `nifra_example`) so any remote AI agent can learn nifra without a local checkout.
 * Both tools read the bundled corpus (llms-full.txt / examples.json shipped in this package) and ignore
 * `cwd`, so they reuse the exact definitions from {@link projectTools} — one source, no drift.
 *
 * The transport itself (body cap, CORS, JSON-RPC dispatch) lives in `@nifrajs/mcp/http`; this module is
 * the docs-specific layer over it: it supplies the bundled corpus tools and the `nifra-docs` server info.
 * {@link handleMcpHttp} self-hosts ANYWHERE Bun runs — the simplest path is `nifra docs-mcp` on a VPS; the
 * same handler runs on Cloudflare/Vercel edge (there inline the corpus as string imports — a Worker has no
 * filesystem). `export default { port, fetch }` also lets `bun run mcp-http.ts` serve it directly.
 */

import { type McpHttpOptions, respondMcpHttp as respondMcpHttpCore } from "@nifrajs/mcp/http"
import type { McpTool } from "@nifrajs/mcp/protocol"
import { loadDocsCorpus } from "./docs-search.ts"
import { loadExamplesCorpus } from "./examples.ts"
import { docsTools } from "./mcp-docs-tools.ts"
import { loadTypesCorpus } from "./types-search.ts"

export type { McpHttpOptions } from "@nifrajs/mcp/http"
export type { Example } from "./examples.ts"
// Re-exported so a self-host (e.g. a Cloudflare-Pages `/mcp` worker route) gets the corpus-injectable
// tool factory + the transport core from one entry: `import { respondMcpHttp, docsTools } from "@nifrajs/cli/mcp"`.
export { docsTools } from "./mcp-docs-tools.ts"
export type { TypeEntry } from "./types-search.ts"

// Kept in lockstep with packages/cli/package.json by check:publish's version-consistency gate.
const VERSION = "1.4.0"
const SERVER_INFO = { name: "nifra-docs", version: VERSION }
const DOCS_HEALTH =
  "nifra docs MCP — POST JSON-RPC 2.0 here (methods: initialize, tools/list, tools/call). Tools: nifra_docs, nifra_example."

/** The two project-independent tools, reading the package's bundled corpus from disk (CLI use). */
export function publicDocsTools(): McpTool[] {
  return docsTools(loadDocsCorpus, loadExamplesCorpus, loadTypesCorpus)
}

/**
 * Handle one MCP request against the given `tools` with the docs server identity. A thin docs-flavored
 * wrapper over the shared {@link respondMcpHttpCore} so the `@nifrajs/cli/mcp` self-host surface keeps its
 * `(request, tools, options?)` shape (the site's edge worker calls it with two args).
 */
export function respondMcpHttp(
  request: Request,
  tools: McpTool[],
  options: McpHttpOptions = {},
): Promise<Response> {
  return respondMcpHttpCore(request, tools, SERVER_INFO, { health: DOCS_HEALTH, ...options })
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
