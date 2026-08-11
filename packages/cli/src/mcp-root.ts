/**
 * Project-root resolution for the stdio MCP server - the answer to the "silently rooted at the wrong
 * project" footgun. The server never trusts a bare `process.cwd()` again:
 *
 *   1. An explicit `nifra mcp <dir>` argument is taken literally (human configuration wins).
 *   2. A cwd guess walks UP to the nearest nifra marker (a `package.json` depending on `@nifrajs/*`,
 *      or a `nifra.config.ts` monorepo root), so running from a subdirectory still finds the project.
 *   3. The client's MCP `roots` (its workspace folders) are requested after the handshake. When the
 *      guess found no project - or found one DISJOINT from every workspace root - and exactly one
 *      workspace root is a nifra project, the server adopts it.
 *   4. What cannot be resolved fails CLOSED: project-scoped tools refuse with a remediation message
 *      instead of describing whatever directory the server happened to start in.
 *
 * Everything here is pure state + fs probes; the I/O wiring lives in `./mcp.ts`.
 */

import { readFile } from "node:fs/promises"
import { dirname, sep } from "node:path"
import { fileURLToPath } from "node:url"

/** How the current root was chosen. `arg` = explicit `nifra mcp <dir>`; `cwd` = the spawn directory;
 * `parent` = a marker found walking up from cwd; `client-root` = adopted from the client's MCP roots. */
export type McpRootSource = "arg" | "cwd" | "parent" | "client-root"

export interface McpRootState {
  /** Absolute directory every project-scoped tool operates on. */
  readonly root: string
  readonly source: McpRootSource
  /** Whether `root` carries a nifra marker. `false` fails project tools closed. */
  readonly isProject: boolean
  /** The client's workspace roots (absolute paths), or `null` until (unless) the client answers
   * `roots/list`. `null` disables mismatch detection - no data is not a mismatch. */
  readonly clientRoots: readonly string[] | null
}

/** A directory is a nifra project when its `package.json` depends on any `@nifrajs/*` package, or it
 * is a `nifra.config.ts` monorepo root. Backend-only projects (no web config, no `routes/`) count -
 * the marker is the dependency, not the app shape. */
export async function isNifraProjectDir(dir: string): Promise<boolean> {
  if (await Bun.file(`${dir}${sep}nifra.config.ts`).exists()) return true
  try {
    const pkg = JSON.parse(await readFile(`${dir}${sep}package.json`, "utf8")) as Record<
      string,
      unknown
    >
    for (const section of ["dependencies", "devDependencies", "peerDependencies"]) {
      const deps = pkg[section]
      if (typeof deps !== "object" || deps === null) continue
      for (const name of Object.keys(deps)) if (name.startsWith("@nifrajs/")) return true
    }
  } catch {
    // No package.json, or unparseable - not a project marker either way.
  }
  return false
}

/** Nearest ancestor (including `start` itself) that is a nifra project, or `null`. */
export async function findNifraRoot(start: string): Promise<string | null> {
  let dir = start
  for (;;) {
    if (await isNifraProjectDir(dir)) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** Initial root state. An explicit dir is taken literally (no walk-up - the human named it); a cwd
 * guess walks up so a subdirectory spawn still lands on the project. */
export async function resolveRootState(
  requested: string,
  explicit: boolean,
): Promise<McpRootState> {
  if (explicit) {
    return {
      root: requested,
      source: "arg",
      isProject: await isNifraProjectDir(requested),
      clientRoots: null,
    }
  }
  const found = await findNifraRoot(requested)
  if (found !== null) {
    return {
      root: found,
      source: found === requested ? "cwd" : "parent",
      isProject: true,
      clientRoots: null,
    }
  }
  return { root: requested, source: "cwd", isProject: false, clientRoots: null }
}

/** `file://` roots from a `roots/list` result, as absolute paths. Non-file and malformed URIs are
 * skipped - the client owns that list, this server only reads it. */
export function pathsFromRootsResult(result: unknown): string[] {
  if (typeof result !== "object" || result === null) return []
  const roots = (result as { roots?: unknown }).roots
  if (!Array.isArray(roots)) return []
  const paths: string[] = []
  for (const entry of roots) {
    const uri = (entry as { uri?: unknown })?.uri
    if (typeof uri !== "string" || !uri.startsWith("file://")) continue
    try {
      paths.push(fileURLToPath(uri))
    } catch {
      // Malformed URI - skip.
    }
  }
  return paths
}

const contains = (parent: string, child: string): boolean =>
  parent === child || child.startsWith(parent + sep)

/** True when the server root and the client's workspace are DISJOINT - neither contains the other.
 * A server rooted at a monorepo whose sub-app is the open workspace (or vice versa) is not a
 * mismatch; a "server points at repo A, workspace is repo B" split is. */
export function rootMismatch(state: McpRootState): boolean {
  if (state.clientRoots === null || state.clientRoots.length === 0) return false
  return !state.clientRoots.some(
    (workspaceRoot) => contains(workspaceRoot, state.root) || contains(state.root, workspaceRoot),
  )
}

/**
 * Fold the client's workspace roots into the state, adopting one of them when the current root is
 * wrong and the correction is unambiguous: the root was GUESSED (never an explicit `nifra mcp <dir>`),
 * it is not a project - or is one disjoint from the whole workspace - and exactly ONE workspace root
 * is a nifra project. Ambiguity (zero or several candidates) adopts nothing; the guard's remediation
 * message lists the candidates instead.
 */
export async function applyClientRoots(
  state: McpRootState,
  paths: readonly string[],
): Promise<McpRootState> {
  const next: McpRootState = { ...state, clientRoots: paths }
  if (state.source === "arg") return next
  if (next.isProject && !rootMismatch(next)) return next
  const candidates: string[] = []
  for (const path of paths) if (await isNifraProjectDir(path)) candidates.push(path)
  if (candidates.length !== 1) return next
  return {
    root: candidates[0] as string,
    source: "client-root",
    isProject: true,
    clientRoots: paths,
  }
}

/** The nifra project roots among the client's workspace roots - the remediation list when adoption
 * was ambiguous. */
export async function nifraCandidates(paths: readonly string[]): Promise<string[]> {
  const candidates: string[] = []
  for (const path of paths) if (await isNifraProjectDir(path)) candidates.push(path)
  return candidates
}

const REMEDIATION =
  "Fix: start the client in the project directory, register the server project-scoped " +
  "(`nifra init-agents` writes .mcp.json), or point it explicitly: `nifra mcp <dir>`."

/** Per-call verdict for the tool guard: `blocked` set = project tools refuse with that message;
 * otherwise `note` is appended to every project tool result so the effective root stays visible. */
export interface McpRootVerdict {
  readonly blocked?: string
  readonly note: string
}

export async function rootVerdict(state: McpRootState): Promise<McpRootVerdict> {
  const workspace =
    state.clientRoots !== null && state.clientRoots.length > 0
      ? ` Client workspace roots: ${state.clientRoots.join(", ")}.`
      : ""
  if (!state.isProject) {
    const candidates = state.clientRoots !== null ? await nifraCandidates(state.clientRoots) : []
    const hint =
      candidates.length > 1
        ? ` Several workspace roots are nifra projects (${candidates.join(", ")}) - pass one: \`nifra mcp <dir>\`.`
        : ""
    return {
      blocked:
        `No nifra project at ${state.root} (no package.json with an @nifrajs/* dependency, no nifra.config.ts). ` +
        `This server only serves the project it is rooted in.${workspace}${hint} ${REMEDIATION}`,
      note: "",
    }
  }
  if (rootMismatch(state)) {
    if (state.source === "arg") {
      // Explicit human configuration wins - annotate, don't block.
      return {
        note: `[nifra] project root: ${state.root} (explicit dir, outside the client workspace)`,
      }
    }
    return {
      blocked:
        `Wrong project: this MCP server is rooted at ${state.root}, which is disjoint from your ` +
        `client's workspace.${workspace} Results would describe a different codebase. ${REMEDIATION}`,
      note: "",
    }
  }
  return { note: `[nifra] project root: ${state.root}` }
}

/** The `initialize`/`server-discover` instructions line announcing the effective root. */
export function rootInstructions(state: McpRootState, drift?: ToolingDrift): string {
  if (!state.isProject) {
    return `WARNING: no nifra project at ${state.root} - project tools will refuse until the server is started in (or pointed at) a nifra project. ${REMEDIATION}`
  }
  return `Serving the nifra project at ${state.root}.${drift === undefined ? "" : ` ${driftNote(drift)}`}`
}

/** A version split between the CLI answering and the nifra the project actually builds with. */
export interface ToolingDrift {
  /** The running CLI's version. */
  readonly cli: string
  /** The version installed in the project. */
  readonly project: string
  /** Which installed package was compared (`@nifrajs/cli` when present, else `@nifrajs/core`). */
  readonly package: string
}

/** One line, on `initialize` and on every project tool result: the answer may describe a different
 * nifra than the project compiles against - stale types, checks, and docs all read as authoritative. */
export const driftNote = (drift: ToolingDrift): string =>
  `WARNING: this server runs nifra CLI ${drift.cli}, but the project installs ${drift.package} ${drift.project}. ` +
  "Types, checks, and docs may describe a different version than your code builds with. " +
  "Fix: run the project's own CLI (`bunx --bun nifra mcp` from the project directory, or point the client at ./node_modules/.bin/nifra)."

/** Feature-level agreement. Patch drift is not reported: it never changes the surface being described. */
const featureVersion = (version: string): string => version.split(".").slice(0, 2).join(".")

async function installedVersion(root: string, name: string): Promise<string | undefined> {
  let dir = root
  for (let depth = 0; depth < 8; depth++) {
    try {
      const meta = JSON.parse(
        await readFile(
          `${dir}${sep}node_modules${sep}${name.split("/").join(sep)}${sep}package.json`,
          "utf8",
        ),
      ) as { version?: unknown }
      if (typeof meta.version === "string" && meta.version.length > 0) return meta.version
    } catch {
      // Not installed at this level - keep walking up (a monorepo app hoists to the repo root).
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/**
 * Compare the running CLI against the nifra the project installs. An agent that asks an older (or
 * newer) CLI about a project gets confident answers about a surface the project does not have -
 * the version sprawl is invisible because every answer still looks authoritative.
 */
export async function detectToolingDrift(
  root: string,
  cliVersion: string,
): Promise<ToolingDrift | undefined> {
  for (const name of ["@nifrajs/cli", "@nifrajs/core"]) {
    const project = await installedVersion(root, name)
    if (project === undefined) continue
    return featureVersion(project) === featureVersion(cliVersion)
      ? undefined
      : { cli: cliVersion, project, package: name }
  }
  return undefined
}
