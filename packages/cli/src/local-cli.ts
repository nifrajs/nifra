/**
 * One nifra per project command: the copy the project installs.
 *
 * `dev`, `build`, `start` and `check` run the app inside this process, beside this CLI's own
 * `@nifrajs/core`. A global or `bun link`ed CLI therefore loads a second core next to the project's,
 * and `nifra check` cannot see it: its scan reads the project, not the CLI that runs it. So a command
 * started from another install hands itself to the project's `@nifrajs/cli`, and when there is none to
 * hand to, says which two copies the app is about to load.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { findProjectCli, handOffSession, isOtherInstall, OWN_CLI_DIR } from "./mcp-delegate.ts"

/** `0` runs the CLI as invoked. Set on the hand-off child, and by hand to try a linked CLI. */
export const LOCAL_CLI_ENV = "NIFRA_LOCAL_CLI"

/** The commands that run the project with this CLI's copy of nifra in the process. */
export const PROJECT_COMMANDS: ReadonlySet<string> = new Set(["dev", "build", "start", "check"])

const MAX_ANCESTOR_DIRS = 8

/** The nearest `@nifrajs/core` install at or above `dir`, resolved through its links. */
function projectCore(dir: string): string | undefined {
  for (let depth = 0; depth < MAX_ANCESTOR_DIRS; depth++) {
    const pkg = join(dir, "node_modules", "@nifrajs", "core")
    if (existsSync(join(pkg, "package.json"))) return realpathSync(pkg)
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/** The `@nifrajs/core` this CLI imports: the package directory above its resolved entry. */
function ownCore(): string | undefined {
  try {
    let dir = dirname(fileURLToPath(import.meta.resolve("@nifrajs/core")))
    for (let depth = 0; depth < MAX_ANCESTOR_DIRS; depth++) {
      const manifest = join(dir, "package.json")
      if (
        existsSync(manifest) &&
        JSON.parse(readFileSync(manifest, "utf8")).name === "@nifrajs/core"
      )
        return realpathSync(dir)
      dir = dirname(dir)
    }
  } catch {
    // Unresolvable from here: nothing to compare.
  }
  return undefined
}

/**
 * Run `command` through the project's own CLI when this one is another install. Resolves to the
 * child's exit code, or `undefined` when this process should run the command itself: then, if the
 * project resolves another `@nifrajs/core` than this CLI, it warns with both paths first.
 */
export async function runThroughLocalCli(options: {
  readonly cwd: string
  readonly version: string
  readonly args: readonly string[]
}): Promise<number | undefined> {
  if (process.env[LOCAL_CLI_ENV] !== "0") {
    const cli = await findProjectCli(options.cwd)
    if (cli?.bin !== undefined && isOtherInstall(cli.dir)) {
      const exit = await handOffSession([process.execPath, cli.bin, ...options.args], {
        cwd: options.cwd,
        env: { ...process.env, [LOCAL_CLI_ENV]: "0" },
        announce: `[nifra] this nifra CLI (${options.version}, ${OWN_CLI_DIR}) is not the project's; running its @nifrajs/cli ${cli.version} from ${cli.dir} (${LOCAL_CLI_ENV}=0 runs this one)`,
      })
      if (exit !== undefined) return exit
    }
  }
  const project = projectCore(options.cwd)
  const own = ownCore()
  if (project !== undefined && own !== undefined && project !== own) {
    console.warn(
      `[nifra] this nifra CLI (${OWN_CLI_DIR}) runs its own @nifrajs/core from ${own}, and the project resolves ${project}: the app loads both, and \`nifra check\` cannot see this CLI's copy. Run the project's CLI (\`./node_modules/.bin/nifra\`, or add it: \`bun add -d @nifrajs/cli\`).`,
    )
  }
  return undefined
}
