/**
 * `nifra init-agents` — retrofit an EXISTING app with the agent-discovery files a freshly scaffolded
 * app ships, so an already-built project adopts the nifra MCP in one command:
 *
 *   .mcp.json          — Claude Code's project MCP registry  (launches `bunx @nifrajs/cli mcp`)
 *   .cursor/mcp.json   — Cursor's MCP registry (same server config)
 *   CLAUDE.md          — Claude's MCP-first preamble + `@AGENTS.md` import
 *   AGENTS.md          — a `## MCP server` section appended (or a minimal file if none exists)
 *
 * The generators are imported from `create-nifra/agent-files` — the SAME source of truth `create-nifra`
 * uses at scaffold time — so a retrofitted app and a freshly scaffolded one get byte-identical configs.
 *
 * Safety: this writes into the user's existing tree, so it NEVER silently clobbers a file they may have
 * customized. By default an existing `.mcp.json` / `CLAUDE.md` / `.cursor/mcp.json` is SKIPPED with a
 * notice; `--force` overwrites. `AGENTS.md` is special-cased — if it already has the MCP section it's
 * left alone, otherwise the section is APPENDED (never overwriting the user's conventions), and `--force`
 * is not needed for that append since it's additive. Every write path is resolved + confined under the
 * cwd (no `..` traversal escaping the project root).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import {
  AGENTS_MD_PATH,
  agentsMcpSection,
  CLAUDE_MD_PATH,
  CURSOR_MCP_JSON_PATH,
  claudeMd,
  MCP_JSON_PATH,
  mcpJson,
} from "create-nifra/agent-files"

/** What happened to one file during the retrofit, for the printed report + the `--json` shape. */
export interface InitAgentsFileResult {
  /** Project-root-relative POSIX path. */
  readonly path: string
  /** `wrote` — created or (with --force) overwrote; `appended` — added the MCP section to an existing
   * AGENTS.md; `skipped` — already present and not forced; `present` — MCP section already there. */
  readonly action: "wrote" | "appended" | "skipped" | "present"
  /** Why it was skipped/left, for the notice (e.g. "exists — pass --force to overwrite"). */
  readonly note?: string
}

export interface InitAgentsResult {
  readonly cwd: string
  readonly files: readonly InitAgentsFileResult[]
}

export interface InitAgentsOptions {
  /** Overwrite an existing `.mcp.json` / `CLAUDE.md` / `.cursor/mcp.json` instead of skipping it. */
  readonly force?: boolean
}

/** Confine a project-relative path under `cwd` and return the absolute path. Rejects a spec that escapes
 * the root (defense-in-depth — these specs are constants, but the cwd-confinement invariant is enforced
 * at the seam, not assumed). Exported so the invariant is directly testable. */
export function safeJoin(cwd: string, rel: string): string {
  const abs = resolve(cwd, rel)
  const within = relative(cwd, abs)
  if (within.startsWith("..") || isAbsolute(within)) {
    throw new Error(`[nifra] refusing to write outside the project root: ${rel}`)
  }
  return abs
}

const fileExists = (path: string): Promise<boolean> =>
  readFile(path)
    .then(() => true)
    .catch(() => false)

/**
 * Write a whole-file generator's output to `path` unless it already exists and `force` is false.
 * Returns the per-file result for the report.
 */
async function writeOwned(
  cwd: string,
  rel: string,
  content: string,
  force: boolean,
): Promise<InitAgentsFileResult> {
  const abs = safeJoin(cwd, rel)
  if (!force && (await fileExists(abs))) {
    return { path: rel, action: "skipped", note: "exists — pass --force to overwrite" }
  }
  // `.cursor/mcp.json` needs its parent dir; `recursive` is a no-op for the root-level files.
  await mkdir(resolve(abs, ".."), { recursive: true })
  await writeFile(abs, content)
  return { path: rel, action: "wrote" }
}

/**
 * AGENTS.md is additive, not owned: if it exists and already has the MCP section, leave it; if it exists
 * without the section, append the section (preserving the user's conventions); if it's absent, write a
 * minimal AGENTS.md that is just the MCP section under a heading. `--force` is irrelevant here — we never
 * overwrite the user's existing guidance.
 */
async function ensureAgentsMd(cwd: string): Promise<InitAgentsFileResult> {
  const abs = safeJoin(cwd, AGENTS_MD_PATH)
  const section = agentsMcpSection()
  let existing: string | undefined
  try {
    existing = await readFile(abs, "utf8")
  } catch {
    existing = undefined // no AGENTS.md yet
  }
  if (existing === undefined) {
    await writeFile(
      abs,
      `# AGENTS.md\n\nGuidance for AI coding agents working in this repo.\n\n${section}\n`,
    )
    return { path: AGENTS_MD_PATH, action: "wrote" }
  }
  // Match on the section heading, not the full body, so a reformatted-but-present section still counts.
  if (existing.includes("## MCP server")) {
    return { path: AGENTS_MD_PATH, action: "present", note: "already has an MCP section" }
  }
  const sep = existing.endsWith("\n") ? "\n" : "\n\n"
  await writeFile(abs, `${existing}${sep}${section}\n`)
  return { path: AGENTS_MD_PATH, action: "appended" }
}

/**
 * Retrofit `cwd` with the four agent-discovery files. Pure enough to unit-test (no argv, no process.exit,
 * no console) — the CLI wrapper handles printing + the exit code.
 */
export async function initAgents(
  cwd: string,
  opts: InitAgentsOptions = {},
): Promise<InitAgentsResult> {
  const force = opts.force ?? false
  // Order: the two MCP registries + CLAUDE.md (owned, no-clobber), then AGENTS.md (additive).
  const files: InitAgentsFileResult[] = []
  files.push(await writeOwned(cwd, MCP_JSON_PATH, mcpJson(), force))
  files.push(await writeOwned(cwd, CURSOR_MCP_JSON_PATH, mcpJson(), force))
  files.push(await writeOwned(cwd, CLAUDE_MD_PATH, claudeMd(), force))
  files.push(await ensureAgentsMd(cwd))
  return { cwd, files }
}

const ACTION_GLYPH: Readonly<Record<InitAgentsFileResult["action"], string>> = {
  wrote: "✓ wrote",
  appended: "✓ appended MCP section to",
  skipped: "• skipped",
  present: "• kept",
}

/** Format the retrofit result for the terminal. */
export function renderInitAgents(result: InitAgentsResult): string {
  const lines = result.files.map((f) => {
    const tail = f.note ? `  (${f.note})` : ""
    return `  ${ACTION_GLYPH[f.action]} ${f.path}${tail}`
  })
  const wroteAny = result.files.some((f) => f.action === "wrote" || f.action === "appended")
  const footer = wroteAny
    ? "\nThe nifra MCP is now registered. Restart your agent so it picks up .mcp.json, then prefer nifra_docs / nifra_example and gate on nifra check."
    : "\nNothing to do — every file was already present (use --force to overwrite the owned ones)."
  return `nifra init-agents\n\n${lines.join("\n")}\n${footer}`
}

/**
 * CLI entry: run the retrofit at `cwd` and print the result. Returns `true` (the command always succeeds
 * unless a write throws — which propagates as a non-zero exit via the dispatcher's catch). `--json`
 * emits the structured result for agents/CI.
 */
export async function runInitAgents(
  cwd: string,
  opts: { readonly json?: boolean; readonly force?: boolean } = {},
): Promise<boolean> {
  const result = await initAgents(cwd, { force: opts.force ?? false })
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(renderInitAgents(result))
  }
  return true
}
