/**
 * The PUBLIC nifra docs MCP - Streamable-HTTP transport exposing the project-INDEPENDENT tools
 * (`nifra_docs`, `nifra_example`, `nifra_types`, `nifra_learn` + the `nifra_gallery` MCP Apps widget)
 * so any remote AI agent can learn nifra without a local checkout. They read the bundled corpus
 * (llms-full.txt / examples.json / types.json shipped in this package) and ignore `cwd`, so they reuse the
 * exact definitions from {@link projectTools} - one source, no drift.
 *
 * The transport itself (body cap, CORS, JSON-RPC dispatch) lives in `@nifrajs/mcp/http`; this module is
 * the docs-specific layer over it: it supplies the bundled corpus tools and the `nifra-docs` server info.
 * {@link handleMcpHttp} self-hosts ANYWHERE Bun runs - the simplest path is `nifra docs-mcp` on a VPS; the
 * same handler runs on Cloudflare/Vercel edge (there inline the corpus as string imports - a Worker has no
 * filesystem). `export default { port, fetch }` also lets `bun run mcp-http.ts` serve it directly.
 */

import { type McpHttpOptions, respondMcpHttp as respondMcpHttpCore } from "@nifrajs/mcp/http"
import { type McpTool, UI_MIME } from "@nifrajs/mcp/protocol"
import { loadDocsCorpus } from "./docs-search.ts"
import { loadExamplesCorpus } from "./examples.ts"
import { examplesAppTool, examplesWidget } from "./mcp-app-tool.ts"
import { docsTools } from "./mcp-docs-tools.ts"
import { loadTypesCorpus } from "./types-search.ts"

export type { McpHttpOptions } from "@nifrajs/mcp/http"
export type { Example } from "./examples.ts"
// Re-exported so a self-host gets the corpus-injectable tool factories + the transport core from one
// entry: `import { respondMcpHttp, docsTools, examplesAppTool } from "@nifrajs/cli/mcp"`.
export { examplesAppTool, examplesWidget } from "./mcp-app-tool.ts"
export { docsTools } from "./mcp-docs-tools.ts"
export type { TypeEntry } from "./types-search.ts"

// Kept in lockstep with packages/cli/package.json by check:publish's version-consistency gate.
const VERSION = "2.14.0"
const SERVER_INFO = { name: "nifra-docs", version: VERSION }
// Derive the GET/health tool list from the tools actually served, so the line can never drift from them.
const docsHealth = (tools: McpTool[]): string =>
  `nifra docs MCP - POST JSON-RPC 2.0 here (methods: initialize, tools/list, tools/call). Tools: ${tools
    .map((tool) => tool.name)
    .join(", ")}.`

/** The project-independent tools, reading the package's bundled corpus from disk (CLI use): the text
 * docs tools plus the `nifra_gallery` MCP Apps widget tool. */
export function publicDocsTools(): McpTool[] {
  return [
    ...docsTools(loadDocsCorpus, loadExamplesCorpus, loadTypesCorpus),
    examplesAppTool(loadExamplesCorpus),
  ]
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
  return respondMcpHttpCore(request, tools, SERVER_INFO, { health: docsHealth(tools), ...options })
}

/** The CLI HTTP handler: serves the disk-backed corpus tools + registers the examples widget's `ui://`
 * resource so MCP Apps hosts can render `nifra_gallery`. (`nifra docs-mcp` / `bun run` this file.) */
export function handleMcpHttp(request: Request): Promise<Response> {
  return respondMcpHttp(request, publicDocsTools(), {
    features: {
      resources: [examplesWidget.resource],
      ui: { mimeTypes: [UI_MIME] },
      instructions:
        "nifra's own documentation, runnable examples, and API types - for building with the nifra framework. Call nifra_docs / nifra_example / nifra_types / nifra_learn to learn it without a local checkout.",
    },
  })
}

/**
 * Worker/edge + local entry. `export default { fetch }` is the universal server shape: Cloudflare /
 * Vercel edge / Deno deploy use `fetch` (and ignore `port`); `bun run mcp-http.ts` auto-serves it on
 * `port` (PORT env, default 8787) - Bun serves a module's default-exported server, so NO manual
 * `Bun.serve` here (that would double-bind the port).
 */
export default {
  port: typeof Bun !== "undefined" ? Number(Bun.env.PORT ?? 8787) : 8787,
  fetch: handleMcpHttp,
}
