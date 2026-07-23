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
import { renderTypesResult, type TypeEntry } from "./types-search.ts"

const clamp = (n: number | undefined, lo: number, hi: number, dflt: number): number =>
  Math.min(Math.max(typeof n === "number" ? n : dflt, lo), hi)

/** Build `nifra_docs` + `nifra_example` + `nifra_types` over injected corpus loaders. */
export function docsTools(
  loadDocs: () => Promise<string | undefined>,
  loadExamples: () => Promise<Example[] | undefined>,
  loadTypes: () => Promise<TypeEntry[] | undefined>,
): McpTool[] {
  return [
    {
      name: "nifra_docs",
      description:
        "Search nifra's framework documentation and get back ONLY the matching sections — auth, uploads, ISR, WebSockets, loaders, deployment, anything. Call with no query for the cheap section index; pass query (e.g. \"isr revalidate\") for the top matching sections. Use this instead of reading llms-full.txt (~150 KB) whole. For the EXACT TypeScript of a type/interface/function, call nifra_types instead (don't read .d.ts files).",
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
    {
      name: "nifra_types",
      description:
        'Get the EXACT TypeScript declaration of any exported @nifrajs/* symbol — interface, type, class, function, const. Each signature is generated from the package\'s built .d.ts, so it is the LITERAL declaration: complete, authoritative, never prose and never truncated. THIS IS THE SOURCE OF TRUTH for nifra\'s types — do NOT read node_modules/@nifrajs/**/*.d.ts; call this instead. Pass `name` for an exact symbol (e.g. "RateLimitStore", "RouteSchema", "Context", "rateLimit"); pass `query` to search by keyword; omit both for the per-package index of names. A `name` lookup is always the complete declaration; a `query` returns a one-line summary plus the signature, collapsing an oversized body — pass `full: true` to override.',
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "Exact symbol name — returns its literal declaration (e.g. RateLimitStore).",
          },
          query: {
            type: "string",
            description:
              "Keyword search over names + signatures (when you don't know the exact name).",
          },
          limit: {
            type: "number",
            description: "Max results for a query/search (default 5, max 8).",
          },
          full: {
            type: "boolean",
            description:
              "Query mode only: return whole declarations instead of collapsed ones. Off by default — a search is for picking a symbol, and one match can be tens of thousands of characters.",
          },
        },
        additionalProperties: false,
      },
      handler: async (args) => {
        const corpus = await loadTypes()
        if (corpus === undefined) {
          return "types corpus missing — run `bun run build && bun run gen:llms` in the nifra repo (published builds ship it)."
        }
        const { name, query, limit, full } = args as {
          name?: string
          query?: string
          limit?: number
          full?: boolean
        }
        return renderTypesResult(corpus, name, query, clamp(limit, 1, 8, 5), full === true)
      },
    },
  ]
}
