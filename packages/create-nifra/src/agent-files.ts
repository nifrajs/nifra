/**
 * The canonical generators for the agent files an app ships. `AGENTS.md` is the single source of agent
 * guidance; every other agent's file is a thin pointer to it, so no two copies can drift:
 *
 *   AGENTS.md                         - the guidance (read natively by Codex, Cursor, Copilot and others)
 *   CLAUDE.md                         - Claude Code: `@AGENTS.md` import
 *   GEMINI.md                         - Gemini CLI: `@./AGENTS.md` import
 *   .cursor/rules/nifra.mdc           - Cursor: an always-applied rule pointing at AGENTS.md
 *   .github/copilot-instructions.md   - GitHub Copilot: points at AGENTS.md
 *   .mcp.json, .cursor/mcp.json       - the nifra MCP server, registered for Claude Code and Cursor
 *
 * Both `create-nifra` (scaffold time) and `@nifrajs/cli`'s `nifra init-agents` (retrofit an existing app)
 * import these, so the files can never drift apart. This module is dependency-free (pure string + object
 * generation) on purpose - `create-nifra` ships with no runtime deps, and `@nifrajs/cli` imports it as a
 * workspace dependency.
 *
 * Why `bunx @nifrajs/cli mcp` (not `bunx nifra mcp`): the `nifra` binary is provided by the
 * `@nifrajs/cli` package, and the bare npm package literally named `nifra` (this monorepo's
 * `@nifrajs/web` shim) exposes NO `nifra` bin, so `bunx nifra mcp` would fetch the wrong package in an
 * app that does not carry `@nifrajs/cli`. Naming the bin-owning package resolves the locally-installed
 * bin when present and otherwise fetches the package that actually provides the `nifra` command.
 */

import { readFileSync } from "node:fs"

/** The MCP launch command, shared by `.mcp.json` and `.cursor/mcp.json`. See the module header for why
 * the package is named explicitly rather than relying on the bare `nifra` bin. */
export const MCP_SERVER_COMMAND = "bunx" as const

/**
 * The `@nifrajs/cli` version the launch command pins to - DERIVED at load time from this package's own
 * `version`, never hardcoded. `fixed` changeset versioning ([["@nifrajs/*", "create-nifra", "nifra"]] in
 * `.changeset/config.json`) bumps `create-nifra` and `@nifrajs/cli` in lockstep, so `create-nifra@x`
 * always means `@nifrajs/cli@x`. Deriving it here means a release bump has nothing to forget to update -
 * there is no stale literal to drift (the 1.0.0 cut shipped a beta pin exactly this way). `check:publish`
 * still asserts it equals `@nifrajs/cli`'s version as a belt-and-suspenders guard on the `fixed` link.
 *
 * Resolves correctly under BOTH export conditions: the `bun` export runs `src/agent-files.ts`
 * (`../package.json` → the package root) and the tsc `default` export runs `dist/agent-files.js`
 * (`../package.json` → the same root, since `dist/` sits beside the manifest). npm always ships a
 * package's own `package.json`, so the read can't miss at install time.
 *
 * Why pin at all instead of `bunx @nifrajs/cli mcp`: `bunx` keys its cache on the exact version spec.
 * An UNPINNED spec resolves to the `latest` tag once, then `bunx` reuses that cached copy on every
 * later spawn WITHOUT re-checking the registry - so an editor that once launched an older `@nifrajs/cli`
 * keeps respawning the stale binary even after a newer one is published (the MCP server silently runs
 * old code). Pinning the exact version makes the version part of the cache key, so each release fetches
 * fresh and a stale cache can never shadow it. The cost: an already-scaffolded app's `.mcp.json` freezes
 * at its scaffold-time version until `nifra init-agents --sync-mcp` re-pins it to the nifra the project
 * installs - an acceptable, deterministic trade.
 */
export const MCP_CLI_VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string
  }
).version
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

/** The one canonical MCP config object both registries serialize - the anti-drift seam. */
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

const POINTER_INTRO =
  "This project's agent guidance - commands, the project structure, the rules, and the nifra MCP server - lives in AGENTS.md, the single source every agent reads."

/** `CLAUDE.md`: Claude Code expands the `@AGENTS.md` import in place. */
export function claudeMd(): string {
  return `# CLAUDE.md\n\n${POINTER_INTRO}\n\n@AGENTS.md\n`
}

/** `GEMINI.md`: Gemini CLI expands `@./AGENTS.md` imports in its context files. */
export function geminiMd(): string {
  return `# GEMINI.md\n\n${POINTER_INTRO}\n\n@./AGENTS.md\n`
}

/** `.cursor/rules/nifra.mdc`: an always-applied Cursor rule; `@AGENTS.md` attaches the file. */
export function cursorRule(): string {
  return `---\ndescription: nifra project guidance\nalwaysApply: true\n---\n\n${POINTER_INTRO} Read it before changing code:\n\n@AGENTS.md\n`
}

/** `.github/copilot-instructions.md`: Copilot has no import syntax, so this names the file. */
export function copilotInstructions(): string {
  return `${POINTER_INTRO} Read AGENTS.md at the repository root before changing code, and follow it.\n`
}

/**
 * The "## MCP server" section appended to a scaffolded (or retrofitted) `AGENTS.md`, so non-Claude
 * agents (Cursor, and anything that reads `AGENTS.md`) also learn the MCP exists and what to prefer.
 * Mirrors the CLAUDE.md preamble's guidance without the Claude-specific `@import`.
 */
export function agentsMcpSection(): string {
  return `## MCP server

This project ships a **nifra MCP server** - launch it with \`${MCP_SERVER_COMMAND} ${MCP_SERVER_ARGS.join(" ")}\`. It's registered for
Claude Code in \`.mcp.json\` and for Cursor in \`.cursor/mcp.json\`; other agents can point their MCP client
at that command. **Prefer its tools** over writing nifra from memory - they're typechecked against this
project + the installed version, so they beat training-data recall:

- \`nifra_docs\` / \`nifra_example\` - exact signatures + verified, compiling snippets.
- \`nifra_context\` / \`nifra_routes\` - this project's route index + per-route schemas.
- \`nifra_types\` - the EXACT TypeScript of any \`@nifrajs/*\` symbol (interface/type/function). Call it for a
  precise type; **never read \`@nifrajs\` \`.d.ts\` files** - this is the authoritative, complete source.
- \`nifra_check\` - the done-gate (typecheck + drift lints). Run it before calling work complete; a
  failing check means it isn't done. (\`nifra check --json\` in a terminal does the same.)`
}

/**
 * The "## Project structure" section of a web app's `AGENTS.md`: the zones the build enforces. Shared so
 * a scaffolded app and one `nifra init-agents` retrofits teach the same rules.
 */
export function agentsStructureSection(): string {
  return `${STRUCTURE_HEADING}

Every file a build loads belongs to one side, and the build refuses an import that crosses the wrong
way - it fails naming the import chain rather than shipping server code to the browser.

| Where | Holds | Reaches the browser |
|---|---|---|
| \`routes/x.tsx\` (\`.svelte\`, \`.vue\`, \`.mdx\`) | a page: the component, \`meta\` | yes |
| \`routes/x.backend.ts\` | that page's \`loader\`, \`action\`, \`loaderOutput\`, \`actionOutput\`, \`middleware\` | never |
| \`frontend/\` | components, hooks, browser-only code | yes |
| \`backend/\` | \`app.ts\` (the API), \`framework.ts\`, the database, auth, secrets | never |
| \`shared/\` | schemas, types and pure helpers both sides import | yes |
| \`public/\` | static files served as they are | yes |

A file outside those folders joins a side with a \`.frontend.ts\`, \`.backend.ts\` or \`.shared.ts\` suffix.

- **A route is two files.** \`routes/blog/[slug].tsx\` renders; \`routes/blog/[slug].backend.ts\` loads.
  A server-only export (\`loader\`, \`action\`, ...) in the \`.tsx\` file is a build error.
- **Frontend code never imports backend code** - not \`backend/\`, not a \`.backend.ts\` file, not a
  database driver or \`node:\` built-in. Data reaches a page only as its loader's return value.
- **Every loader and action declares what it sends**: \`export const loaderOutput = t.object({ ... })\`
  (and \`actionOutput\`). Only what the schema declares reaches the browser, and a loader without one
  is refused.
- **Type a route with its generated \`./+types/<name>\`**: \`import type { Route } from "./+types/[slug]"\`
  gives \`Route.LoaderArgs\` (with the typed \`api\`) in the backend half and \`Route.ComponentProps\` in
  the page. \`nifra dev\`, \`nifra build\`, \`nifra check\` and \`nifra types\` write them.
- **Secrets stay in \`backend/\`.** A value only the server may see is read there (\`process.env\`), never
  in a frontend file; a build that finds what looks like a credential in browser output fails.`
}

/** The heading `nifra init-agents` looks for before appending {@link agentsStructureSection}. */
export const STRUCTURE_HEADING = "## Project structure"

/** Identifies a generated agent-discovery file: where it goes (relative to the project root) and how to
 * produce its content. `merge` is for files that augment an existing one (AGENTS.md) rather than own it. */
export interface AgentFileSpec {
  /** Path relative to the project root (POSIX-style; the caller joins onto the cwd). */
  readonly path: string
  /** A human label for the "wrote/skipped" report. */
  readonly label: string
}

/** The standalone files this module fully owns (whole-file generators). AGENTS.md is handled separately
 * because create-nifra builds it from `agents.ts` and the retrofit command appends sections to it. */
export const MCP_JSON_PATH = ".mcp.json"
export const CURSOR_MCP_JSON_PATH = ".cursor/mcp.json"
export const CLAUDE_MD_PATH = "CLAUDE.md"
export const GEMINI_MD_PATH = "GEMINI.md"
export const CURSOR_RULE_PATH = ".cursor/rules/nifra.mdc"
export const COPILOT_INSTRUCTIONS_PATH = ".github/copilot-instructions.md"
export const AGENTS_MD_PATH = "AGENTS.md"

/** Every agent's pointer to `AGENTS.md`, in the order they are written and reported. */
export const AGENT_POINTERS: readonly { readonly path: string; readonly content: () => string }[] =
  [
    { path: CLAUDE_MD_PATH, content: claudeMd },
    { path: GEMINI_MD_PATH, content: geminiMd },
    { path: CURSOR_RULE_PATH, content: cursorRule },
    { path: COPILOT_INSTRUCTIONS_PATH, content: copilotInstructions },
  ]
