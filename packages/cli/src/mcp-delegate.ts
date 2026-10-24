/**
 * One nifra per MCP session: the version the project installs.
 *
 * A client that spawns a globally installed `nifra mcp` against a project pinned to a different
 * release gets types, checks, docs and contracts for a surface the project does not have - and every
 * answer still reads as authoritative. So the server settles the version before it serves:
 *
 *   1. The project installs its own `@nifrajs/cli` at a different version: hand the whole session to
 *      that CLI (its `bin` script, run by this Bun with `--no-env-file`, stdio inherited) and step aside.
 *   2. Handing off is impossible (no project CLI, a missing bin, or this process IS the hand-off and
 *      the versions still disagree): serve, but the version-sensitive tools refuse with the fix
 *      instead of answering for the wrong release.
 */

import { existsSync, realpathSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { McpTool, McpToolResult } from "./mcp-protocol.ts"
import type { ToolingDrift } from "./mcp-root.ts"

/** Set on the hand-off child so it never hands off again, whatever it finds. */
export const MCP_DELEGATED_ENV = "NIFRA_MCP_DELEGATED"

/** The tools whose answer is a property of the nifra release: they refuse under a version split. */
export const VERSION_SENSITIVE_TOOLS: ReadonlySet<string> = new Set([
  "nifra_check",
  "nifra_types",
  "nifra_docs",
  "nifra_example",
  "nifra_assure",
  "nifra_contracts",
])

/** The project's own CLI: its version, its package directory, and, when it is on disk, the script
 * its `bin` names. */
export interface ProjectCli {
  readonly version: string
  readonly dir: string
  readonly bin?: string
}

const MAX_ANCESTOR_DIRS = 8

function binScript(bin: unknown): string | undefined {
  if (typeof bin === "string") return bin
  if (typeof bin !== "object" || bin === null) return undefined
  const named: unknown = Reflect.get(bin, "nifra")
  return typeof named === "string" ? named : undefined
}

/** The nearest `@nifrajs/cli` install at or above `root` (a monorepo app hoists to the repo root). */
export async function findProjectCli(root: string): Promise<ProjectCli | undefined> {
  let dir = root
  for (let depth = 0; depth < MAX_ANCESTOR_DIRS; depth++) {
    const pkg = join(dir, "node_modules", "@nifrajs", "cli")
    try {
      const meta = JSON.parse(await readFile(join(pkg, "package.json"), "utf8")) as {
        version?: unknown
        bin?: unknown
      }
      if (typeof meta.version === "string" && meta.version.length > 0) {
        const script = binScript(meta.bin)
        const bin = script === undefined ? undefined : join(pkg, script)
        return bin !== undefined && existsSync(bin)
          ? { version: meta.version, dir: pkg, bin }
          : { version: meta.version, dir: pkg }
      }
    } catch {
      // Not installed at this level - keep walking up.
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/** This CLI's package directory: the parent of `src/` or `dist/`, where this module sits. */
export const OWN_CLI_DIR = fileURLToPath(new URL("..", import.meta.url))

/** Whether `dir` is another install than this CLI's own: a version can match while the copy, and the
 * `@nifrajs/core` beside it, does not. */
export function isOtherInstall(dir: string): boolean {
  try {
    return realpathSync(dir) !== realpathSync(OWN_CLI_DIR)
  } catch {
    return false
  }
}

/**
 * Hand this stdio session to the project's own CLI when it installs a different version, or the same
 * version from another directory. Resolves to the child's exit code once the session ends, or
 * `undefined` when this process should serve itself (this is the project's CLI, no project CLI or
 * bin, already a hand-off, or the spawn failed). Must run before anything reads stdin: the child
 * inherits the descriptor and owns the whole conversation.
 */
export async function delegateToProjectCli(options: {
  readonly cwd: string
  readonly root: string
  readonly version: string
  readonly args: readonly string[]
}): Promise<number | undefined> {
  if (process.env[MCP_DELEGATED_ENV] === "1") return undefined
  const cli = await findProjectCli(options.root)
  if (
    cli === undefined ||
    cli.bin === undefined ||
    (cli.version === options.version && !isOtherInstall(cli.dir))
  )
    return undefined
  // Not the `.bin` shim: its `bun` would load the project's `.env`, and the inherited
  // NIFRA_MCP_WITHOUT_ENV_FILES then tells that CLI the values are already gone.
  return handOffSession([process.execPath, "--no-env-file", cli.bin, "mcp", ...options.args], {
    cwd: options.cwd,
    env: { ...process.env, [MCP_DELEGATED_ENV]: "1" },
    announce: `[nifra] mcp: this CLI is ${options.version}; the project installs @nifrajs/cli ${cli.version} - serving this session from ${cli.bin}`,
  })
}

/**
 * Hand this stdio session to `command`: the child inherits stdin, stdout and stderr and owns the
 * whole conversation, and this process forwards signals and waits. Resolves to the child's exit code,
 * or `undefined` when it could not start. Must run before anything reads stdin.
 */
export async function handOffSession(
  command: readonly string[],
  options: {
    readonly cwd: string
    readonly env: Record<string, string | undefined>
    /** Written to stderr once the child runs. */
    readonly announce?: string
  },
): Promise<number | undefined> {
  let child: ReturnType<typeof Bun.spawn>
  try {
    child = Bun.spawn([...command], {
      cwd: options.cwd,
      env: options.env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    })
  } catch {
    return undefined
  }
  // stderr only: stdout is the JSON-RPC channel, and it now belongs to the child.
  if (options.announce !== undefined) process.stderr.write(`${options.announce}\n`)
  const forward = (signal: NodeJS.Signals) => () => child.kill(signal)
  const onTerm = forward("SIGTERM")
  const onInt = forward("SIGINT")
  process.on("SIGTERM", onTerm)
  process.on("SIGINT", onInt)
  try {
    return await child.exited
  } finally {
    process.off("SIGTERM", onTerm)
    process.off("SIGINT", onInt)
  }
}

const refusalFix = (drift: ToolingDrift): string =>
  drift.package === "@nifrajs/cli"
    ? "Fix: point the MCP client at the project's own CLI (`./node_modules/.bin/nifra mcp`, reinstalling if that file is missing), or restart this server from the project directory so it hands the session over."
    : `Fix: add the matching CLI to the project (\`bun add -d @nifrajs/cli@${drift.project}\`) and restart the MCP server - it then hands the session to the project's CLI - or point the client at a nifra ${drift.project} install.`

/** The in-band refusal a version-sensitive tool returns under a version split. */
export const versionRefusal = (tool: string, drift: ToolingDrift): McpToolResult => ({
  content: [
    {
      type: "text",
      text:
        `${tool} refused: this MCP server runs nifra CLI ${drift.cli}, but the project installs ${drift.package} ${drift.project}, ` +
        `so its answer would describe a different nifra than your code builds with. ${refusalFix(drift)}`,
    },
  ],
  isError: true,
})

/**
 * Swap each version-sensitive tool's handler for the refusal while `drift` holds. Apply it before
 * namespacing, so a monorepo's `nifra_<app>_check` refuses too. No drift: the tools pass through.
 */
export function refuseVersionSensitive(
  tools: McpTool[],
  drift: ToolingDrift | undefined,
): McpTool[] {
  if (drift === undefined) return tools
  return tools.map((tool) =>
    VERSION_SENSITIVE_TOOLS.has(tool.name)
      ? { ...tool, handler: async () => versionRefusal(tool.name, drift) }
      : tool,
  )
}
