/**
 * `nifra init-agents` - retrofit an EXISTING app with the agent files a freshly scaffolded app ships, so
 * an already-built project adopts them in one command:
 *
 *   .mcp.json, .cursor/mcp.json   - the nifra MCP server for Claude Code and Cursor
 *   CLAUDE.md, GEMINI.md, .cursor/rules/nifra.mdc, .github/copilot-instructions.md
 *                                 - each agent's pointer to AGENTS.md, the single source of guidance
 *   AGENTS.md                     - the `## MCP server` section, and for an app with `routes/` the
 *                                   `## Project structure` section, appended when missing (or a minimal
 *                                   file if none exists)
 *
 * The generators come from `./agent-files.ts`, a byte-identical copy of the module `create-nifra` uses at
 * scaffold time, so a retrofitted app and a freshly scaffolded one get byte-identical configs.
 *
 * Safety: this writes into the user's existing tree, so it NEVER silently clobbers a file they may have
 * customized. By default an existing `.mcp.json` / `CLAUDE.md` / `.cursor/mcp.json` is SKIPPED with a
 * notice; `--force` overwrites. `AGENTS.md` is special-cased - a section it already has is left alone,
 * a missing one is APPENDED (never overwriting the user's conventions), and `--force` is not needed for
 * that append since it's additive. Every write path is resolved + confined under the
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

import { readFileSync, type Stats } from "node:fs"
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import {
  AGENT_POINTERS,
  AGENTS_MD_PATH,
  agentsMcpSection,
  agentsStructureSection,
  CLAUDE_MD_PATH,
  CURSOR_MCP_JSON_PATH,
  MCP_CLI_VERSION,
  MCP_JSON_PATH,
  MCP_SERVER_COMMAND,
  mcpJson,
  STRUCTURE_HEADING,
} from "./agent-files.ts"
import { installedNifraVersion, resolveRootState } from "./mcp-root.ts"

/** What happened to one file during the retrofit, for the printed report + the `--json` shape. */
export interface InitAgentsFileResult {
  /** Project-root-relative POSIX path. */
  readonly path: string
  /** `wrote` - created or (with --force) overwrote; `appended` - added missing sections to an existing
   * AGENTS.md; `skipped` - already present and not forced (or, under --sync-mcp, absent or unpinned);
   * `present` - every section already there (or, under --sync-mcp, already pinned to the target);
   * `synced` - --sync-mcp rewrote a stale pinned version or named the workspace member. */
  readonly action: "wrote" | "appended" | "skipped" | "present" | "synced"
  /** Why it was skipped/left, for the notice (e.g. "exists - pass --force to overwrite"). */
  readonly note?: string
}

export interface InitAgentsResult {
  readonly cwd: string
  readonly files: readonly InitAgentsFileResult[]
  /** Under --sync-mcp: the `@nifrajs/cli` version every pin was brought to, or {@link UNPINNED}. */
  readonly syncedTo?: string
}

/** `syncedTo` when every launch was unpinned to follow the project's installed CLI. */
export const UNPINNED = "installed"

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

/** Never write anything that is not a plain absent-or-regular file: a symlink here would redirect
 * the write, and a directory or device node would make it fail in a confusing way. Such a file is
 * reported and left alone rather than stopping the run - a symlinked CLAUDE.md is a common alias
 * for AGENTS.md. */
async function nonRegularTarget(
  abs: string,
  rel: string,
): Promise<InitAgentsFileResult | undefined> {
  const stat = await lstatOrMissing(abs)
  if (stat === undefined || (stat.isFile() && !stat.isSymbolicLink())) return undefined
  return { path: rel, action: "skipped", note: "not a regular file - left alone" }
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
  const irregular = await nonRegularTarget(abs, rel)
  if (irregular !== undefined) return irregular
  if (!force && (await fileExists(abs))) {
    return { path: rel, action: "skipped", note: "exists - pass --force to overwrite" }
  }
  // A nested file (`.cursor/`, `.github/`) needs its parent dir; `recursive` is a no-op at the root.
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
 * AGENTS.md is additive, not owned: each section it lacks is appended (preserving the user's
 * conventions), each it has is left alone, and an absent file is written with just those sections.
 * `--force` is irrelevant here - we never overwrite the user's existing guidance. The structure section
 * is for an app with `routes/`; an API-only app has no frontend to keep apart.
 */
async function ensureAgentsMd(cwd: string, pin?: string): Promise<InitAgentsFileResult> {
  const abs = safeJoin(cwd, AGENTS_MD_PATH)
  await assertSafeParents(cwd, abs)
  const irregular = await nonRegularTarget(abs, AGENTS_MD_PATH)
  if (irregular !== undefined) return irregular
  const sections = [{ heading: "## MCP server", text: agentsMcpSection(pin) }]
  if (await isDirectory(safeJoin(cwd, "routes"))) {
    sections.push({ heading: STRUCTURE_HEADING, text: agentsStructureSection() })
  }
  let existing: string | undefined
  try {
    existing = await readFile(abs, "utf8")
  } catch {
    existing = undefined // no AGENTS.md yet
  }
  if (existing === undefined) {
    const body = sections.map((section) => section.text).join("\n\n")
    await atomicWrite(
      abs,
      `# AGENTS.md\n\nGuidance for AI coding agents working in this repo.\n\n${body}\n`,
    )
    return { path: AGENTS_MD_PATH, action: "wrote" }
  }
  // Match on the section heading, not the full body, so a reformatted-but-present section still counts.
  const current = existing
  const missing = sections.filter((section) => !current.includes(section.heading))
  if (missing.length === 0) {
    return { path: AGENTS_MD_PATH, action: "present", note: "already has every section" }
  }
  const sep = current.endsWith("\n") ? "\n" : "\n\n"
  await atomicWrite(abs, `${current}${sep}${missing.map((section) => section.text).join("\n\n")}\n`)
  const names = missing.map((section) => section.heading.slice(3)).join(" + ")
  return { path: AGENTS_MD_PATH, action: "appended", note: names }
}

const isDirectory = (path: string): Promise<boolean> =>
  lstat(path)
    .then((stat) => stat.isDirectory())
    .catch(() => false)

/** An exact version: the only pin --sync-mcp rewrites. A dist-tag or a range is a deliberate choice,
 * not a scaffold-time freeze. Prerelease and build suffixes are part of the version. */
const PIN_VERSION = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`
/** The launch as both MCP registries hold it: one JSON string in the server's `args`, pinned (group 1
 * is the version) or unpinned, which follows the project's install. */
const JSON_PIN = new RegExp(`"@nifrajs/cli(?:@(${PIN_VERSION}))?"`, "g")
/** The launch as the markdown quotes it: the whole command, so prose that merely mentions a version
 * (an upgrade note, a changelog line) is never touched. */
const LAUNCH_PIN = new RegExp(`${MCP_SERVER_COMMAND} @nifrajs/cli(?:@(${PIN_VERSION}))? mcp`, "g")

/** The one nifra workspace member `cwd` resolves to, as a POSIX path relative to it, when `cwd` is a
 * workspace root and not itself a nifra project. */
async function workspaceMember(cwd: string): Promise<string | undefined> {
  const state = await resolveRootState(cwd, false)
  return state.source === "workspace" ? relative(cwd, state.root).split(sep).join("/") : undefined
}

/** The registries' launch args when they name no directory: `["@nifrajs/cli@x.y.z", "mcp"]`, pinned or
 * not. Group 2 is the whitespace between the two, reused before the member so the file keeps its own
 * layout. */
const JSON_BARE_LAUNCH = new RegExp(
  `("@nifrajs/cli(?:@${PIN_VERSION})?"\\s*,(\\s*)"mcp")(\\s*\\])`,
  "g",
)

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

export interface PinScan {
  /** The input with every stale pin rewritten - every other character untouched. */
  readonly text: string
  /** Launches found, pinned or not, current or stale. */
  readonly pins: number
  /** The distinct stale versions, in order of appearance. */
  readonly stale: readonly string[]
  /** The workspace member this scan added to a launch that named no directory. */
  readonly named?: string
}

/**
 * Move every pinned launch to `target`, or unpin it when `target` is `null` (the project installs the
 * CLI, so the launch follows that install). An unpinned launch is already current: it is never pinned
 * again, since dropping the pin was a choice.
 */
function repin(text: string, pattern: RegExp, target: string | null): PinScan {
  let pins = 0
  const stale: string[] = []
  const rewritten = text.replace(pattern, (match: string, version: string | undefined) => {
    pins++
    if (version === undefined || version === target) return match
    if (!stale.includes(version)) stale.push(version)
    return match.replace(`@${version}`, () => (target === null ? "" : `@${target}`))
  })
  return { text: rewritten, pins, stale }
}

/** AGENTS.md is the user's file: only its `## MCP server` section - the heading up to the next `#` or
 * `##` heading, or the end of the file - is ours to re-pin. */
function repinMcpSection(text: string, target: string | null): PinScan {
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
function repinRegistry(text: string, target: string | null, member?: string): PinScan {
  const scan = repin(text, JSON_PIN, target)
  if (member === undefined || scan.pins === 0) return scan
  const { text: rewritten, named } = nameMember(scan.text, member)
  return named ? { ...scan, text: rewritten, named: member } : scan
}

/** Every file that carries the pin, and the part of it --sync-mcp and `nifra upgrade --write` may
 * rewrite. */
export const PIN_SITES: readonly {
  readonly path: string
  readonly repin: (text: string, target: string | null, member?: string) => PinScan
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
  target: string | null,
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
  if (scan.pins === 0) return { kind: "skip", note: "no @nifrajs/cli launch command" }
  if (scan.stale.length === 0 && scan.named === undefined) return { kind: "current" }
  return { kind: "stale", abs, mode: stat.mode & 0o777, scan }
}

/** A pinned file above the project whose every nifra launch serves the project. */
export interface AncestorPinSite {
  /** The directory that holds it. */
  readonly dir: string
  /** Where the file is, from the project directory, as reports name it (`../.mcp.json`). */
  readonly path: string
  /** The site it is, its `path` relative to `dir`. */
  readonly site: (typeof PIN_SITES)[number]
  /** The member a bare registry launch is given, as `init-agents` at that root would. */
  readonly member: string
}

/** Pinned files above the project, split by whether a member's re-pin may rewrite them. */
export interface AncestorPins {
  readonly owned: readonly AncestorPinSite[]
  /** Pinned files that also launch something else, or that the scan could not attribute. */
  readonly foreign: readonly { readonly path: string; readonly note: string }[]
}

const REGISTRY_PATHS: ReadonlySet<string> = new Set([MCP_JSON_PATH, CURSOR_MCP_JSON_PATH])
const LAUNCH_ARG = new RegExp(`^@nifrajs/cli(?:@${PIN_VERSION})?$`)

/** The directories above `dir`, nearest first, up to the repository root; none outside a repository. */
async function ancestorsToRepoRoot(dir: string): Promise<string[]> {
  const out: string[] = []
  for (let at = dir; (await lstatOrMissing(join(at, ".git"))) === undefined; ) {
    const parent = dirname(at)
    if (parent === at) return []
    out.push(parent)
    at = parent
  }
  return out
}

/** Whether a launch from `dir` that names no directory serves `project`, as `nifra mcp` resolves it. */
async function bareLaunchServes(dir: string, project: string): Promise<boolean> {
  const state = await resolveRootState(dir, false)
  return state.isProject && (await realpath(state.root).catch(() => state.root)) === project
}

/** Each pinned launch in an MCP registry: the directory it names, `null` for none, `undefined` for
 * a pin not followed by `mcp`. The whole result is `undefined` when a pin sits outside any launch. */
function registryLaunches(text: string): (string | null | undefined)[] | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const servers: unknown = Reflect.get(Object(parsed), "mcpServers")
  const launches: (string | null | undefined)[] = []
  for (const entry of Object.values(Object(servers))) {
    const args: unknown = Reflect.get(Object(entry), "args")
    if (!Array.isArray(args)) continue
    args.forEach((arg, i) => {
      if (typeof arg !== "string" || !LAUNCH_ARG.test(arg)) return
      const named: unknown = args[i + 2]
      if (args[i + 1] !== "mcp") launches.push(undefined)
      else launches.push(typeof named === "string" && !named.startsWith("-") ? named : null)
    })
  }
  return [...text.matchAll(JSON_PIN)].length === launches.length ? launches : undefined
}

/**
 * The pinned files above `cwd`, up to the repository root. A workspace root's registry launches
 * `mcp <member>`, which is what `init-agents` writes there, so a member's re-pin has to reach it. A
 * file is the member's to rewrite only when every nifra launch in it serves the member, resolved the
 * way `nifra mcp` resolves it; a file that also serves another project is reported and left alone.
 */
export async function ancestorPins(cwd: string): Promise<AncestorPins> {
  const project = await realpath(cwd).catch(() => resolve(cwd))
  const owned: AncestorPinSite[] = []
  const foreign: { path: string; note: string }[] = []
  for (const dir of await ancestorsToRepoRoot(project)) {
    let bare: Promise<boolean> | undefined
    const servesBare = () => (bare ??= bareLaunchServes(dir, project))
    const launchServes = async (named: string | null | undefined): Promise<boolean> =>
      named === undefined
        ? false
        : named === null
          ? servesBare()
          : (await realpath(resolve(dir, named)).catch(() => "")) === project
    for (const site of PIN_SITES) {
      const abs = join(dir, site.path)
      const path = relative(project, abs).split(sep).join("/")
      const stat = await lstatOrMissing(abs)
      if (stat === undefined || stat.isDirectory()) continue
      if (!stat.isFile()) {
        foreign.push({ path, note: "not a regular file - left alone" })
        continue
      }
      const text = await readFile(abs, "latin1")
      let serves: boolean
      if (REGISTRY_PATHS.has(site.path)) {
        const launches = registryLaunches(text)
        if (launches === undefined) {
          foreign.push({ path, note: "holds a pin no launch accounts for - left alone" })
          continue
        }
        if (launches.length === 0) continue
        serves = true
        for (const named of launches) if (!(await launchServes(named))) serves = false
      } else {
        if (site.repin(text, MCP_CLI_VERSION).pins === 0) continue
        serves = await servesBare()
      }
      if (serves)
        owned.push({ dir, path, site, member: relative(dir, project).split(sep).join("/") })
      else foreign.push({ path, note: "its launch is not this project's alone - left alone" })
    }
  }
  return { owned, foreign }
}

/** Whether the project at `dir` declares `@nifrajs/cli` in its own manifest, so `bunx` run there
 * finds its install. */
export function declaresCli(dir: string): boolean {
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
    return ["dependencies", "devDependencies", "optionalDependencies"].some((field) =>
      Object.hasOwn(Object(Reflect.get(Object(manifest), field)), "@nifrajs/cli"),
    )
  } catch {
    return false
  }
}

/**
 * What --sync-mcp and `nifra upgrade --write` move the project's own launches to: `null`, unpinned,
 * when the project declares `@nifrajs/cli`, so the launch follows that install from then on; otherwise
 * {@link mcpPinTarget}. Only the launch directory's own manifest counts: a workspace root whose member
 * declares the CLI keeps the pin, since an isolated install puts no `nifra` bin at the root and bunx
 * would fetch the latest release instead.
 */
export async function mcpLaunchTarget(cwd: string): Promise<string | null> {
  return declaresCli(cwd) ? null : mcpPinTarget(cwd)
}

/**
 * The version a pinned launch moves to: the nifra the project installs, so the server an agent launches
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

/** One file whose launch command pins a version other than {@link mcpLaunchTarget}. */
export interface StaleMcpPin {
  readonly path: string
  readonly pinned: readonly string[]
}

/** Read-only: every agent file whose pinned `@nifrajs/cli` is not the one the project installs. */
export async function collectStaleMcpPins(
  cwd: string,
): Promise<{ readonly target: string | null; readonly files: readonly StaleMcpPin[] }> {
  const target = await mcpLaunchTarget(cwd)
  const files: StaleMcpPin[] = []
  for (const site of PIN_SITES) {
    const state = await readPin(cwd, site, target)
    if (state.kind === "stale") files.push({ path: site.path, pinned: state.scan.stale })
  }
  // A launch above the project runs from that directory, so it stays pinned.
  const pinned = target ?? (await mcpPinTarget(cwd))
  for (const above of (await ancestorPins(cwd)).owned) {
    const state = await readPin(above.dir, above.site, pinned)
    if (state.kind === "stale") files.push({ path: above.path, pinned: state.scan.stale })
  }
  return { target, files }
}

/** --sync-mcp: rewrite each stale pin to the project's version and touch nothing else. Creates no
 * file and appends no section - a file without a pin is reported, not repaired. */
async function syncMcpPins(cwd: string): Promise<InitAgentsResult> {
  const target = await mcpLaunchTarget(cwd)
  const member = await workspaceMember(cwd)
  const files: InitAgentsFileResult[] = []
  const sync = async (path: string, state: PinState, to: string | null): Promise<void> => {
    if (state.kind === "skip") {
      files.push({ path, action: "skipped", note: state.note })
    } else if (state.kind === "current") {
      files.push({
        path,
        action: "present",
        note: to === null ? "already follows the installed CLI" : `already pinned to ${to}`,
      })
    } else {
      await atomicWrite(state.abs, Buffer.from(state.scan.text, "latin1"), state.mode)
      const moved = to ?? "the installed CLI (unpinned)"
      const notes = [
        ...(state.scan.stale.length > 0 ? [`${state.scan.stale.join(", ")} -> ${moved}`] : []),
        ...(state.scan.named !== undefined ? [`launches \`mcp ${state.scan.named}\``] : []),
      ]
      files.push({ path, action: "synced", note: notes.join("; ") })
    }
  }
  for (const site of PIN_SITES)
    await sync(site.path, await readPin(cwd, site, target, member), target)
  const above = await ancestorPins(cwd)
  const pinned = target ?? (await mcpPinTarget(cwd))
  for (const site of above.owned)
    await sync(site.path, await readPin(site.dir, site.site, pinned, site.member), pinned)
  for (const { path, note } of above.foreign) files.push({ path, action: "skipped", note })
  return { cwd, files, syncedTo: target ?? UNPINNED }
}

/**
 * Retrofit `cwd` with the agent files. Pure enough to unit-test (no argv, no process.exit,
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
  // Order: the two MCP registries and each agent's pointer (owned, no-clobber), then AGENTS.md (additive).
  const member = await workspaceMember(cwd)
  const pin = declaresCli(cwd) ? undefined : MCP_CLI_VERSION
  const registry = member === undefined ? mcpJson(pin) : nameMember(mcpJson(pin), member).text
  const files: InitAgentsFileResult[] = []
  files.push(await writeOwned(cwd, MCP_JSON_PATH, registry, force))
  files.push(await writeOwned(cwd, CURSOR_MCP_JSON_PATH, registry, force))
  for (const pointer of AGENT_POINTERS) {
    files.push(await writeOwned(cwd, pointer.path, pointer.content(), force))
  }
  files.push(await ensureAgentsMd(cwd, pin))
  // A file the run left alone may still launch an old CLI. Say so where the file is reported, with
  // the command that fixes only that. Advisory: a file it cannot read costs the hint, not the run.
  const { target, files: stale } = await collectStaleMcpPins(cwd).catch(() => ({
    target: "",
    files: [] as readonly StaleMcpPin[],
  }))
  const fix =
    target === null
      ? "`nifra init-agents --sync-mcp` unpins it to follow the installed CLI"
      : `\`nifra init-agents --sync-mcp\` re-pins it to ${target}`
  return {
    cwd,
    files: files.map((file) => {
      const pin = stale.find((entry) => entry.path === file.path)
      if (pin === undefined || (file.action !== "skipped" && file.action !== "present")) return file
      const hint = `pinned to ${pin.pinned.join(", ")}; ${fix}`
      return { ...file, note: file.note === undefined ? hint : `${file.note}; ${hint}` }
    }),
  }
}

const ACTION_GLYPH: Readonly<Record<InitAgentsFileResult["action"], string>> = {
  wrote: "✓ wrote",
  appended: "✓ appended to",
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
    const launch =
      result.syncedTo === UNPINNED
        ? "runs the installed @nifrajs/cli (unpinned), so an upgrade needs no re-pin"
        : `pins @nifrajs/cli@${result.syncedTo}`
    const footer = result.files.some((f) => f.action === "synced")
      ? `\nThe nifra MCP launch now ${launch}. Restart your agent so it respawns the server.`
      : result.syncedTo === UNPINNED
        ? "\nNothing to re-pin - every launch already follows the installed @nifrajs/cli."
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
