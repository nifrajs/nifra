/**
 * The two project-INDEPENDENT MCP tools — `nifra_docs` + `nifra_example` — as a single factory shared
 * by every transport: the project stdio server ({@link projectTools}), the CLI HTTP server
 * (`nifra docs-mcp`), and the site's Cloudflare-Pages worker (`/mcp`). The corpus source is injected as
 * loaders, so the SAME tool definitions work whether the corpus comes from disk (`Bun.file`, on the
 * CLI) or a cached same-origin fetch (on the edge, no filesystem). One source → the tools can never be
 * described differently across surfaces.
 */

import { renderDocsResult } from "./docs-search.ts"
import { type Example, renderExamplesResult } from "./examples.ts"
import type { McpTool } from "./mcp-protocol.ts"

const clamp = (n: number | undefined, lo: number, hi: number, dflt: number): number =>
  Math.min(Math.max(typeof n === "number" ? n : dflt, lo), hi)

/** Build `nifra_docs` + `nifra_example` over injected corpus loaders. */
export function docsTools(
  loadDocs: () => Promise<string | undefined>,
  loadExamples: () => Promise<Example[] | undefined>,
): McpTool[] {
  return [
    {
      name: "nifra_docs",
      description:
        'Search nifra\'s framework documentation and get back ONLY the matching sections — auth, uploads, ISR, WebSockets, loaders, deployment, anything. Call with no query for the cheap section index; pass query (e.g. "isr revalidate") for the top matching sections. Use this instead of reading llms-full.txt (~150 KB) whole.',
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Keywords to match against doc sections (omit for the index).",
          },
          limit: { type: "number", description: "Max sections to return (default 3, max 5)." },
        },
        additionalProperties: false,
      },
      handler: async (args) => {
        const corpus = await loadDocs()
        if (corpus === undefined) {
          return "docs corpus missing — run `bun run gen:llms` in the nifra repo (published builds ship it)."
        }
        const { query, limit } = args as { query?: string; limit?: number }
        return renderDocsResult(corpus, query, clamp(limit, 1, 5, 3))
      },
    },
    {
      name: "nifra_example",
      description:
        'Get a VERIFIED, copy-pasteable nifra code example for a task — auth route, file upload, ISR page, loader/action, typed client, SSE, deployment, etc. Every snippet is typechecked against the installed nifra version, so it compiles as-is. PREFER THIS over writing nifra code from memory (training data drifts). Call with no query for the grouped index; pass query (e.g. "protected route", "upload", "isr revalidate") for matching snippets.',
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "What you want an example of (omit for the index).",
          },
          limit: { type: "number", description: "Max examples to return (default 3, max 5)." },
        },
        additionalProperties: false,
      },
      handler: async (args) => {
        const corpus = await loadExamples()
        if (corpus === undefined) {
          return "examples corpus missing — run `bun run gen:llms` in the nifra repo (published builds ship it)."
        }
        const { query, limit } = args as { query?: string; limit?: number }
        return renderExamplesResult(corpus, query, clamp(limit, 1, 5, 3))
      },
    },
  ]
}
