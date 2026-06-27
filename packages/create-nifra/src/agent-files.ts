/**
 * The canonical generators for the agent-discovery files an app ships so a coding agent auto-discovers
 * the project's nifra MCP server and prefers it over writing nifra from memory:
 *
 *   .mcp.json          — Claude Code's project MCP registry  ({ mcpServers: { nifra: { command, args } } })
 *   .cursor/mcp.json   — Cursor's MCP registry (same server config)
 *   CLAUDE.md          — Claude's preamble (use the MCP first; gate on `nifra check`) + `@AGENTS.md` import
 *   AGENTS.md "MCP"    — a section for non-Claude agents pointing at the same server
 *
 * Single source of truth: both `create-nifra` (scaffold time) and `@nifrajs/cli`'s `nifra init-agents`
 * (retrofit an existing app) import these, so the four files can never drift apart. This module is
 * dependency-free (pure string + object generation) on purpose — `create-nifra` ships with no runtime
 * deps, and `@nifrajs/cli` imports it as a workspace dependency.
 *
 * Why `bunx @nifrajs/cli mcp` (not `bunx nifra mcp`): the `nifra` binary is provided by the
 * `@nifrajs/cli` package. A scaffolded `site` app carries `@nifrajs/cli` as a devDependency, so either
 * spelling would resolve `node_modules/.bin/nifra` locally — BUT the `api`/`isr` templates do NOT carry
 * `@nifrajs/cli`, and the bare npm package literally named `nifra` (this monorepo's `@nifrajs/web` shim)
 * exposes NO `nifra` bin. So `bunx nifra mcp` would fetch the wrong package and fail there. Naming the
 * bin-owning package, `bunx @nifrajs/cli mcp`, resolves the locally-installed bin when present and
 * otherwise fetches the package that actually provides the `nifra` command — robust across every
 * template and for any existing app.
 */

/** The MCP launch command, shared by `.mcp.json` and `.cursor/mcp.json`. See the module header for why
 * the package is named explicitly rather than relying on the bare `nifra` bin. */
export const MCP_SERVER_COMMAND = "bunx" as const

/**
 * The `@nifrajs/cli` version the launch command pins to. Kept in lockstep with the published
 * `@nifrajs/cli` version by `scripts/version.ts` (alongside the cli.ts / mcp-http.ts constants).
 *
 * Why pin at all instead of `bunx @nifrajs/cli mcp`: `bunx` keys its cache on the exact version spec.
 * An UNPINNED spec resolves to the `latest` tag once, then `bunx` reuses that cached copy on every
 * later spawn WITHOUT re-checking the registry — so an editor that once launched an older `@nifrajs/cli`
 * keeps respawning the stale binary even after a newer one is published (the MCP server silently runs
 * old code). Pinning the exact version makes the version part of the cache key, so each release fetches
 * fresh and a stale cache can never shadow it. The cost: an already-scaffolded app's `.mcp.json` freezes
 * at its scaffold-time version until `nifra init-agents` is re-run — an acceptable, deterministic trade.
 */
export const MCP_CLI_VERSION = "1.0.0-beta.3" as const
export const MCP_SERVER_ARGS = [`@nifrajs/cli@${MCP_CLI_VERSION}`, "mcp"] as const

/** The server entry registered under the `nifra` key in both Claude Code's and Cursor's MCP config. */
export interface McpServerConfig {
  readonly command: string
  readonly args: readonly string[]
}

/** Claude Code / Cursor MCP config shape: a map of server name → launch config. */
export interface McpConfig {
  readonly mcpServers: Readonly<Record<string, McpServerConfig>>
}

/** The one canonical MCP config object both registries serialize — the anti-drift seam. */
export const MCP_CONFIG: McpConfig = {
  mcpServers: {
    nifra: { command: MCP_SERVER_COMMAND, args: [...MCP_SERVER_ARGS] },
  },
}

/** Serialize the canonical MCP config as the JSON written to `.mcp.json` and `.cursor/mcp.json`.
 * Trailing newline so the file is POSIX-clean and diffs don't flag a missing EOL. */
export function mcpJson(): string {
  return `${JSON.stringify(MCP_CONFIG, null, 2)}\n`
}

/**
 * `CLAUDE.md` — Claude Code reads this automatically. It is deliberately NOT a copy of `AGENTS.md`:
 * a short preamble that (1) tells Claude this project ships a nifra MCP, registered in `.mcp.json`, and
 * to PREFER it, and (2) pulls in the full cookbook with Claude Code's `@file` import directive on its
 * own line — `@AGENTS.md` — so the conventions live in exactly one place and can't drift between the
 * two files. Keep this short; the depth is in `AGENTS.md`.
 */
export function claudeMd(): string {
  return `# CLAUDE.md

This project ships a **nifra MCP server**, registered for Claude Code in \`.mcp.json\` (it launches with
\`${MCP_SERVER_COMMAND} ${MCP_SERVER_ARGS.join(" ")}\`). **Prefer the MCP tools** over writing nifra from memory — they are
typechecked against *this* project and this installed version, so they beat training-data recall:

- \`nifra_docs\` / \`nifra_example\` — exact signatures + verified, compiling snippets. Reach for these
  before hand-writing a route, a loader, or a client call; a remembered API is often stale or wrong.
- \`nifra_context\` — this project's route index + conventions, so changes fit the existing surface.
- **\`nifra_check\` is the done-gate.** Before declaring any change complete, run \`nifra_check\` (or
  \`nifra check --json\` in a terminal). It typechecks the frontend↔backend contract and flags drift
  (hand-rolled \`fetch()\` to this app's own API, server-only imports in \`routes/\`). A failing check
  means the work isn't done — fix it, don't ship around it.

The full nifra cookbook for this app — backend rules, the typed never-throwing client, file routing, and
the gotchas — lives in \`AGENTS.md\`, imported here so it stays the single source of truth:

@AGENTS.md
`
}

/**
 * The "## MCP server" section appended to a scaffolded (or retrofitted) `AGENTS.md`, so non-Claude
 * agents (Cursor, and anything that reads `AGENTS.md`) also learn the MCP exists and what to prefer.
 * Mirrors the CLAUDE.md preamble's guidance without the Claude-specific `@import`.
 */
export function agentsMcpSection(): string {
  return `## MCP server

This project ships a **nifra MCP server** — launch it with \`${MCP_SERVER_COMMAND} ${MCP_SERVER_ARGS.join(" ")}\`. It's registered for
Claude Code in \`.mcp.json\` and for Cursor in \`.cursor/mcp.json\`; other agents can point their MCP client
at that command. **Prefer its tools** over writing nifra from memory — they're typechecked against this
project + the installed version, so they beat training-data recall:

- \`nifra_docs\` / \`nifra_example\` — exact signatures + verified, compiling snippets.
- \`nifra_context\` / \`nifra_routes\` — this project's route index + per-route schemas.
- \`nifra_check\` — the done-gate (typecheck + drift lints). Run it before calling work complete; a
  failing check means it isn't done. (\`nifra check --json\` in a terminal does the same.)`
}

/** Identifies a generated agent-discovery file: where it goes (relative to the project root) and how to
 * produce its content. `merge` is for files that augment an existing one (AGENTS.md) rather than own it. */
export interface AgentFileSpec {
  /** Path relative to the project root (POSIX-style; the caller joins onto the cwd). */
  readonly path: string
  /** A human label for the "wrote/skipped" report. */
  readonly label: string
}

/** The standalone files this module fully owns (whole-file generators). AGENTS.md is handled separately
 * because create-nifra builds it from `agents.ts` and the retrofit command appends a section to it. */
export const MCP_JSON_PATH = ".mcp.json"
export const CURSOR_MCP_JSON_PATH = ".cursor/mcp.json"
export const CLAUDE_MD_PATH = "CLAUDE.md"
export const AGENTS_MD_PATH = "AGENTS.md"
