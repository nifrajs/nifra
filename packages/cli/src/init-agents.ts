/**
 * `nifra init-agents` - retrofit an EXISTING app with the agent-discovery files a freshly scaffolded
 * app ships, so an already-built project adopts the nifra MCP in one command:
 *
 *   .mcp.json          - Claude Code's project MCP registry  (launches `bunx @nifrajs/cli mcp`)
 *   .cursor/mcp.json   - Cursor's MCP registry (same server config)
 *   CLAUDE.md          - Claude's MCP-first preamble + `@AGENTS.md` import
 *   AGENTS.md          - a `## MCP server` section appended (or a minimal file if none exists)
 *
 * The generators are imported from `create-nifra/agent-files` - the SAME source of truth `create-nifra`
 * uses at scaffold time - so a retrofitted app and a freshly scaffolded one get byte-identical configs.
 *
 * Safety: this writes into the user's existing tree, so it NEVER silently clobbers a file they may have
 * customized. By default an existing `.mcp.json` / `CLAUDE.md` / `.cursor/mcp.json` is SKIPPED with a
 * notice; `--force` overwrites. `AGENTS.md` is special-cased - if it already has the MCP section it's
 * left alone, otherwise the section is APPENDED (never overwriting the user's conventions), and `--force`
 * is not needed for that append since it's additive. Every write path is resolved + confined under the
 * cwd (no `..` traversal escaping the project root).
 *
 * `--sync-mcp` is the upgrade path: the launch command pins an exact `@nifrajs/cli` version, so after
 * the app upgrades nifra every existing file still launches the old CLI. It rewrites that version and
 * nothing else - the pin in both MCP registries and the launch command in CLAUDE.md and AGENTS.md's
 * MCP section - to the nifra the project installs, leaving every other byte of every file as it was.
 *
 * At a workspace root that is not itself a nifra project but has exactly one nifra member, both runs
 * also name that member in the registries' launch args (`mcp app`), so the server keeps its root when
 * a second nifra member arrives.
 */

import type { Stats } from "node:fs"
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import {
  AGENTS_MD_PATH,
  agentsMcpSection,
  CLAUDE_MD_PATH,
  CURSOR_MCP_JSON_PATH,
  claudeMd,
  MCP_CLI_VERSION,
  MCP_JSON_PATH,
  MCP_SERVER_COMMAND,
  mcpJson,
} from "create-nifra/agent-files"
import { installedNifraVersion, resolveRootState } from "./mcp-root.ts"

/** What happened to one file during the retrofit, for the printed report + the `--json` shape. */
export interface InitAgentsFileResult {
  /** Project-root-relative POSIX path. */
  readonly path: string
  /** `wrote` - created or (with --force) overwrote; `appended` - added the MCP section to an existing
   * AGENTS.md; `skipped` - already present and not forced (or, under --sync-mcp, absent or unpinned);
   * `present` - MCP section already there (or, under --sync-mcp, already pinned to the target);
   * `synced` - --sync-mcp rewrote a stale pinned version or named the workspace member. */
  readonly action: "wrote" | "appended" | "skipped" | "present" | "synced"
  /** Why it was skipped/left, for the notice (e.g. "exists - pass --force to overwrite"). */
  readonly note?: string
}

export interface InitAgentsResult {
  readonly cwd: string
  readonly files: readonly InitAgentsFileResult[]
  /** Under --sync-mcp: the `@nifrajs/cli` version every pin was brought to. */
  readonly syncedTo?: string
}

export interface InitAgentsOptions {
  /** Overwrite an existing `.mcp.json` / `CLAUDE.md` / `.cursor/mcp.json` instead of skipping it. */
  readonly force?: boolean
  /** Rewrite only the pinned `@nifrajs/cli` version (and, at a workspace root, the member the launch
   * names) in the existing files; create and append nothing. */
  readonly syncMcp?: boolean
}

/** Confine a project-relative path under `cwd` and return the absolute path. Rejects a spec that escapes
 * the root (defense-in-depth - these specs are constants, but the cwd-confinement invariant is enforced
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

/** `lstat`, with "it isn't there" reported as `undefined` instead of a throw. Every other failure
 * (EACCES, ELOOP, ...) still propagates - only absence is an expected outcome here. */
async function lstatOrMissing(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

/**
 * Refuse to write through a symlinked ancestor. `safeJoin` only proves the *textual* path stays
 * under the project root; a symlinked `.cursor` still lands the write wherever it points. The walk
 * stops at the first missing segment - `mkdir` will create the rest, so there is nothing to check.
 */
async function assertSafeParents(cwd: string, abs: string): Promise<void> {
  const rel = relative(cwd, resolve(abs, ".."))
  let current = cwd
  for (const part of rel.split(/[\\/]/).filter(Boolean)) {
    current = resolve(current, part)
    const stat = await lstatOrMissing(current)
    if (stat === undefined) break
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`[nifra] refusing unsafe parent path: ${part}`)
    }
  }
}

/** Refuse to write anything that is not a plain absent-or-regular file: a symlink here would
 * redirect the write, and a directory or device node would make it fail in a confusing way. */
async function assertRegularTarget(abs: string, rel: string): Promise<void> {
  const stat = await lstatOrMissing(abs)
  if (stat !== undefined && (stat.isSymbolicLink() || !stat.isFile())) {
    throw new Error(`[nifra] refusing to write non-regular file: ${rel}`)
  }
}

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
  await assertSafeParents(cwd, abs)
  await assertRegularTarget(abs, rel)
  if (!force && (await fileExists(abs))) {
    return { path: rel, action: "skipped", note: "exists - pass --force to overwrite" }
  }
  // `.cursor/mcp.json` needs its parent dir; `recursive` is a no-op for the root-level files.
  await mkdir(resolve(abs, ".."), { recursive: true })
  await atomicWrite(abs, content)
  return { path: rel, action: "wrote" }
}

/** Write via a sibling temp file so a crash mid-write can't leave a half-written config in place.
 * `wx` fails rather than following an existing name, and the temp is cleaned up on any failure so a
 * botched run doesn't litter the user's project. `mode` carries a replaced file's permissions over. */
async function atomicWrite(
  abs: string,
  content: string | Uint8Array,
  mode?: number,
): Promise<void> {
  const tmp = `${abs}.nifra-${process.pid}-${Date.now()}`
  await writeFile(tmp, content, { flag: "wx" })
  try {
    if (mode !== undefined) await chmod(tmp, mode)
    await rename(tmp, abs)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

/**
 * AGENTS.md is additive, not owned: if it exists and already has the MCP section, leave it; if it exists
 * without the section, append the section (preserving the user's conventions); if it's absent, write a
 * minimal AGENTS.md that is just the MCP section under a heading. `--force` is irrelevant here - we never
 * overwrite the user's existing guidance.
 */
async function ensureAgentsMd(cwd: string): Promise<InitAgentsFileResult> {
  const abs = safeJoin(cwd, AGENTS_MD_PATH)
  await assertSafeParents(cwd, abs)
  await assertRegularTarget(abs, AGENTS_MD_PATH)
  const section = agentsMcpSection()
  let existing: string | undefined
  try {
    existing = await readFile(abs, "utf8")
  } catch {
    existing = undefined // no AGENTS.md yet
  }
  if (existing === undefined) {
    await atomicWrite(
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
  await atomicWrite(abs, `${existing}${sep}${section}\n`)
  return { path: AGENTS_MD_PATH, action: "appended" }
}

/** An exact version: the only pin --sync-mcp rewrites. A dist-tag or a range is a deliberate choice,
 * not a scaffold-time freeze. Prerelease and build suffixes are part of the version. */
const PIN_VERSION = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`
/** The pin as both MCP registries hold it: one JSON string in the server's `args`. */
const JSON_PIN = new RegExp(`"@nifrajs/cli@(${PIN_VERSION})"`, "g")
/** The pin as the markdown quotes it: the whole launch command, so prose that merely mentions a
 * version (an upgrade note, a changelog line) is never touched. */
const LAUNCH_PIN = new RegExp(`${MCP_SERVER_COMMAND} @nifrajs/cli@(${PIN_VERSION}) mcp`, "g")

/** The one nifra workspace member `cwd` resolves to, as a POSIX path relative to it, when `cwd` is a
 * workspace root and not itself a nifra project. */
async function workspaceMember(cwd: string): Promise<string | undefined> {
  const state = await resolveRootState(cwd, false)
  return state.source === "workspace" ? relative(cwd, state.root).split(sep).join("/") : undefined
}

/** The registries' launch args when they name no directory: `["@nifrajs/cli@x.y.z", "mcp"]`. Group 2
 * is the whitespace between the two, reused before the member so the file keeps its own layout. */
const JSON_BARE_LAUNCH = new RegExp(`("@nifrajs/cli@${PIN_VERSION}"\\s*,(\\s*)"mcp")(\\s*\\])`, "g")

/** Add `member` after a bare `"mcp"` launch arg; a launch that already names a directory is left alone. */
function nameMember(
  text: string,
  member: string,
): { readonly text: string; readonly named: boolean } {
  let named = false
  const rewritten = text.replace(
    JSON_BARE_LAUNCH,
    (_match: string, launch: string, gap: string, close: string) => {
      named = true
      return `${launch},${gap}${JSON.stringify(member)}${close}`
    },
  )
  return { text: rewritten, named }
}

interface PinScan {
  /** The input with every stale pin rewritten - every other character untouched. */
  readonly text: string
  /** Pins found, current or stale. */
  readonly pins: number
  /** The distinct stale versions, in order of appearance. */
  readonly stale: readonly string[]
  /** The workspace member this scan added to a launch that named no directory. */
  readonly named?: string
}

function repin(text: string, pattern: RegExp, target: string): PinScan {
  let pins = 0
  const stale: string[] = []
  const rewritten = text.replace(pattern, (match: string, version: string) => {
    pins++
    if (version === target) return match
    if (!stale.includes(version)) stale.push(version)
    return match.replace(`@${version}`, () => `@${target}`)
  })
  return { text: rewritten, pins, stale }
}

/** AGENTS.md is the user's file: only its `## MCP server` section - the heading up to the next `#` or
 * `##` heading, or the end of the file - is ours to re-pin. */
function repinMcpSection(text: string, target: string): PinScan {
  const heading = /^## MCP server\b.*$/m.exec(text)
  if (heading === null) return { text, pins: 0, stale: [] }
  const start = heading.index + heading[0].length
  const next = /^#{1,2}[ \t]/m.exec(text.slice(start))
  const end = next === null ? text.length : start + next.index
  const section = repin(text.slice(start, end), LAUNCH_PIN, target)
  return { ...section, text: text.slice(0, start) + section.text + text.slice(end) }
}

/** An MCP registry: its pin, and at a workspace root the member its launch names. Only the registries
 * launch the server, so the markdown launch commands keep their wording. */
function repinRegistry(text: string, target: string, member?: string): PinScan {
  const scan = repin(text, JSON_PIN, target)
  if (member === undefined || scan.pins === 0) return scan
  const { text: rewritten, named } = nameMember(scan.text, member)
  return named ? { ...scan, text: rewritten, named: member } : scan
}

/** Every file that carries the pin, and the part of it --sync-mcp may rewrite. */
const PIN_SITES: readonly {
  readonly path: string
  readonly repin: (text: string, target: string, member?: string) => PinScan
}[] = [
  { path: MCP_JSON_PATH, repin: repinRegistry },
  { path: CURSOR_MCP_JSON_PATH, repin: repinRegistry },
  { path: CLAUDE_MD_PATH, repin: (text, target) => repin(text, LAUNCH_PIN, target) },
  { path: AGENTS_MD_PATH, repin: repinMcpSection },
]

type PinState =
  | { readonly kind: "skip"; readonly note: string }
  | { readonly kind: "current" }
  | {
      readonly kind: "stale"
      readonly abs: string
      readonly mode: number
      readonly scan: PinScan
    }

/** Where one file's pin stands against `target`. Never throws on a file it would not write: a
 * symlinked CLAUDE.md (a common alias for AGENTS.md) is reported and left alone, not a hard stop. */
async function readPin(
  cwd: string,
  site: (typeof PIN_SITES)[number],
  target: string,
  member?: string,
): Promise<PinState> {
  const abs = safeJoin(cwd, site.path)
  try {
    await assertSafeParents(cwd, abs)
  } catch (error) {
    return {
      kind: "skip",
      note: `left alone - ${(error as Error).message.replace(/^\[nifra\] /, "")}`,
    }
  }
  const stat = await lstatOrMissing(abs)
  if (stat === undefined) return { kind: "skip", note: "absent - `nifra init-agents` creates it" }
  if (stat.isSymbolicLink() || !stat.isFile())
    return { kind: "skip", note: "not a regular file - left alone" }
  // latin1 is one char per byte, so writing it back reproduces every byte outside a pin exactly,
  // whatever the file's encoding; the pin patterns are ASCII, so they match as they would in UTF-8.
  const scan = site.repin(await readFile(abs, "latin1"), target, member)
  if (scan.pins === 0) return { kind: "skip", note: "no pinned @nifrajs/cli launch command" }
  if (scan.stale.length === 0 && scan.named === undefined) return { kind: "current" }
  return { kind: "stale", abs, mode: stat.mode & 0o777, scan }
}

/**
 * The version --sync-mcp pins to: the nifra the project installs, so the server an agent launches
 * describes the surface the code builds with. The running CLI's own version when nothing is
 * installed. Not simply the running CLI's version: the command that fixes a drifted server is run
 * by that drifted CLI, and it must not re-pin to itself.
 */
export async function mcpPinTarget(cwd: string): Promise<string> {
  const installed = await installedNifraVersion(cwd)
  if (installed !== undefined) return installed.version
  // A workspace with isolated installs keeps nifra in the member's own node_modules.
  const member = await workspaceMember(cwd)
  const memberInstalled =
    member === undefined ? undefined : await installedNifraVersion(resolve(cwd, member))
  return memberInstalled?.version ?? MCP_CLI_VERSION
}

/** One file whose launch command pins a version other than {@link mcpPinTarget}. */
export interface StaleMcpPin {
  readonly path: string
  readonly pinned: readonly string[]
}

/** Read-only: every agent file whose pinned `@nifrajs/cli` is not the one the project installs. */
export async function collectStaleMcpPins(
  cwd: string,
): Promise<{ readonly target: string; readonly files: readonly StaleMcpPin[] }> {
  const target = await mcpPinTarget(cwd)
  const files: StaleMcpPin[] = []
  for (const site of PIN_SITES) {
    const state = await readPin(cwd, site, target)
    if (state.kind === "stale") files.push({ path: site.path, pinned: state.scan.stale })
  }
  return { target, files }
}

/** --sync-mcp: rewrite each stale pin to the project's version and touch nothing else. Creates no
 * file and appends no section - a file without a pin is reported, not repaired. */
async function syncMcpPins(cwd: string): Promise<InitAgentsResult> {
  const target = await mcpPinTarget(cwd)
  const member = await workspaceMember(cwd)
  const files: InitAgentsFileResult[] = []
  for (const site of PIN_SITES) {
    const state = await readPin(cwd, site, target, member)
    if (state.kind === "skip") {
      files.push({ path: site.path, action: "skipped", note: state.note })
    } else if (state.kind === "current") {
      files.push({ path: site.path, action: "present", note: `already pinned to ${target}` })
    } else {
      await atomicWrite(state.abs, Buffer.from(state.scan.text, "latin1"), state.mode)
      const notes = [
        ...(state.scan.stale.length > 0 ? [`${state.scan.stale.join(", ")} -> ${target}`] : []),
        ...(state.scan.named !== undefined ? [`launches \`mcp ${state.scan.named}\``] : []),
      ]
      files.push({ path: site.path, action: "synced", note: notes.join("; ") })
    }
  }
  return { cwd, files, syncedTo: target }
}

/**
 * Retrofit `cwd` with the four agent-discovery files. Pure enough to unit-test (no argv, no process.exit,
 * no console) - the CLI wrapper handles printing + the exit code.
 */
export async function initAgents(
  cwd: string,
  opts: InitAgentsOptions = {},
): Promise<InitAgentsResult> {
  const force = opts.force ?? false
  if (opts.syncMcp === true) {
    // --force rewrites whole files; --sync-mcp exists to promise it will not. Combined, one of the
    // two promises breaks, so refuse rather than pick.
    if (force) throw new Error("[nifra] --sync-mcp cannot be combined with --force")
    return syncMcpPins(cwd)
  }
  // Order: the two MCP registries + CLAUDE.md (owned, no-clobber), then AGENTS.md (additive).
  const member = await workspaceMember(cwd)
  const registry = member === undefined ? mcpJson() : nameMember(mcpJson(), member).text
  const files: InitAgentsFileResult[] = []
  files.push(await writeOwned(cwd, MCP_JSON_PATH, registry, force))
  files.push(await writeOwned(cwd, CURSOR_MCP_JSON_PATH, registry, force))
  files.push(await writeOwned(cwd, CLAUDE_MD_PATH, claudeMd(), force))
  files.push(await ensureAgentsMd(cwd))
  // A file the run left alone may still launch an old CLI. Say so where the file is reported, with
  // the command that fixes only that. Advisory: a file it cannot read costs the hint, not the run.
  const { target, files: stale } = await collectStaleMcpPins(cwd).catch(() => ({
    target: "",
    files: [] as readonly StaleMcpPin[],
  }))
  return {
    cwd,
    files: files.map((file) => {
      const pin = stale.find((entry) => entry.path === file.path)
      if (pin === undefined || (file.action !== "skipped" && file.action !== "present")) return file
      const hint = `pinned to ${pin.pinned.join(", ")}; \`nifra init-agents --sync-mcp\` re-pins it to ${target}`
      return { ...file, note: file.note === undefined ? hint : `${file.note}; ${hint}` }
    }),
  }
}

const ACTION_GLYPH: Readonly<Record<InitAgentsFileResult["action"], string>> = {
  wrote: "✓ wrote",
  appended: "✓ appended MCP section to",
  skipped: "• skipped",
  present: "• kept",
  synced: "✓ re-pinned",
}

/** Format the retrofit result for the terminal. */
export function renderInitAgents(result: InitAgentsResult): string {
  const lines = result.files.map((f) => {
    const tail = f.note ? `  (${f.note})` : ""
    return `  ${ACTION_GLYPH[f.action]} ${f.path}${tail}`
  })
  if (result.syncedTo !== undefined) {
    const footer = result.files.some((f) => f.action === "synced")
      ? `\nThe nifra MCP launch now pins @nifrajs/cli@${result.syncedTo}. Restart your agent so it respawns the server.`
      : `\nNothing to re-pin - no file pins a version other than @nifrajs/cli@${result.syncedTo}.`
    return `nifra init-agents --sync-mcp\n\n${lines.join("\n")}\n${footer}`
  }
  const wroteAny = result.files.some((f) => f.action === "wrote" || f.action === "appended")
  const footer = wroteAny
    ? "\nThe nifra MCP is now registered. Restart your agent so it picks up .mcp.json, then prefer nifra_docs / nifra_example and gate on nifra check."
    : "\nNothing to do - every file was already present (use --force to overwrite the owned ones)."
  return `nifra init-agents\n\n${lines.join("\n")}\n${footer}`
}

/**
 * CLI entry: run the retrofit at `cwd` and print the result. Returns `true` (the command always succeeds
 * unless a write throws - which propagates as a non-zero exit via the dispatcher's catch). `--json`
 * emits the structured result for agents/CI.
 */
export async function runInitAgents(
  cwd: string,
  opts: { readonly json?: boolean; readonly force?: boolean; readonly syncMcp?: boolean } = {},
): Promise<boolean> {
  const result = await initAgents(cwd, {
    force: opts.force ?? false,
    syncMcp: opts.syncMcp ?? false,
  })
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(renderInitAgents(result))
  }
  return true
}
