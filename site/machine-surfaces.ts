/**
 * Small, public machine-readable surfaces for agents discovering nifra.dev.
 *
 * Keep this deliberately product-focused: nifra.dev is the home of an open-source framework and
 * documentation MCP server, not a hosted customer-data API.
 */
export const AGENTS_MD = [
  "# Nifra",
  "",
  "Nifra is an open-source, Bun-native, multi-runtime TypeScript framework for typed HTTP APIs and",
  "full-stack SSR. It runs one app across Bun, Node, Deno, Cloudflare Workers, and Vercel Edge, with",
  "React, Solid, Vue, Preact, and Svelte adapters.",
  "",
  "## When to use Nifra",
  "",
  "Use Nifra when you are building:",
  "",
  "- a typed JSON API with runtime validation and a zero-codegen client;",
  "- a full-stack SSR application with loaders, actions, streaming, SSG, or ISR;",
  "- an application that coding agents need to inspect, modify, and verify safely;",
  "- an agent product using typed tools, MCP, A2A, or AG-UI protocol bridges.",
  "",
  "## Start here",
  "",
  "- Getting started: https://nifra.dev/docs",
  "- API and typed client: https://nifra.dev/docs/api",
  "- Coding agents: https://nifra.dev/docs/agents",
  "- Types-first architecture: https://nifra.dev/docs/types-first",
  "- Contract-derived testing: https://nifra.dev/docs/testing",
  "- Complete LLM index: https://nifra.dev/llms.txt",
  "- Complete reference: https://nifra.dev/llms-full.txt",
  "- Generated API reference: https://nifra.dev/api-reference.md",
  "",
  "## Install",
  "",
  "~~~sh",
  "bun create nifra my-app",
  "bun add @nifrajs/core @nifrajs/schema @nifrajs/client",
  "~~~",
  "",
  "## Agent surfaces",
  "",
  "- Hosted documentation MCP (read-only, stateless): https://mcp.nifra.dev",
  "- MCP discovery metadata: https://nifra.dev/.well-known/mcp",
  "- Local project MCP: run nifra mcp inside a Nifra repository.",
  "- Project instructions: https://github.com/nifrajs/nifra/blob/main/AGENTS.md",
  "- MCP registry metadata: https://github.com/nifrajs/nifra/blob/main/server.json",
  "",
  "## Important boundary",
  "",
  "Nifra is a framework, not a hosted SaaS product. nifra.dev does not expose a customer-data REST API,",
  "OAuth login, checkout, or payment flow. Applications built with Nifra expose their own routes and",
  "can generate OpenAPI documents from their contracts with openapi() or nifra openapi.",
  "",
  "## Source and packages",
  "",
  "- Source: https://github.com/nifrajs/nifra",
  "- npm package: https://www.npmjs.com/package/nifra",
  "- npm organization: https://www.npmjs.com/org/nifrajs",
].join("\n")

export const MCP_DISCOVERY = {
  $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  name: "io.github.nifrajs/nifra-docs",
  title: "Nifra docs",
  description:
    "Nifra docs, runnable examples, and API types as an MCP server for any AI assistant.",
  version: "3.2.0",
  repository: {
    url: "https://github.com/nifrajs/nifra",
    source: "github",
  },
  websiteUrl: "https://nifra.dev",
  remotes: [{ type: "streamable-http", url: "https://mcp.nifra.dev" }],
} as const

export const MCP_DISCOVERY_JSON = `${JSON.stringify(MCP_DISCOVERY, null, 2)}\n`

export function machineSurfaceResponse(body: string, contentType: string): Response {
  return new Response(body, {
    headers: {
      "cache-control": "public, max-age=3600",
      "content-type": contentType,
    },
  })
}

export function machineSurfaceFor(request: Request): Response | undefined {
  const pathname = new URL(request.url).pathname
  if (pathname === "/agents.md")
    return machineSurfaceResponse(AGENTS_MD, "text/markdown; charset=utf-8")
  if (pathname === "/.well-known/mcp")
    return machineSurfaceResponse(MCP_DISCOVERY_JSON, "application/json; charset=utf-8")
  return undefined
}
