/**
 * The MCP JSON-RPC dispatch now lives in `@nifrajs/mcp` (shared with nifra apps that expose their own
 * MCP server / MCP Apps widgets). This module is a thin re-export so the CLI's existing imports — and
 * the `@nifrajs/cli/mcp` self-host surface — keep resolving here unchanged.
 */

export * from "@nifrajs/mcp/protocol"
