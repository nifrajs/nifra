/**
 * `--env-file <path>` for every `nifra` command.
 *
 * Most nifra commands (`check`, `assure`, `levels`, `routes`, `capabilities`, `manifest`, `contracts`,
 * `openapi`, `types`) reflect a project by IMPORTING it, and a production-grade app validates its
 * environment at module scope. Without the app's environment those commands do not report a gate
 * failure - the app's own validator kills the process before nifra reaches its first check, and the
 * only output is the app's `FATAL: invalid environment` with nothing tying it to the command that was
 * run. This flag supplies that environment the same way `bun --env-file` / `node --env-file` do, so a
 * project whose env lives in an uncommitted `.env.local` stays checkable.
 *
 * Two deliberate rules:
 *   - A variable already present in `process.env` WINS. The shell (and CI's secret store) is the more
 *     explicit source; a checked-in defaults file must never shadow it.
 *   - A missing file is an error, never a silent no-op. `--env-file .env.prod` that quietly did nothing
 *     would make the command look like it verified an environment it never loaded.
 */
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

const ENV_FILE_FLAG = "--env-file"

/**
 * A `KEY=VALUE` line. `export ` is tolerated so a file that is also `source`-able works. The key is
 * POSIX-shaped on purpose: it keeps a stray `- foo` bullet or a YAML `key: value` line from being read
 * as an assignment when the wrong file is passed.
 */
const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/

/** Strip one layer of matching quotes; a double-quoted value also expands `\n`, `\r`, `\t` and `\"`. */
function unquote(raw: string): string {
  const value = raw.trim()
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\([nrt"\\])/g, (_, char: string) =>
        char === "n" ? "\n" : char === "r" ? "\r" : char === "t" ? "\t" : char,
      )
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
  // Unquoted: an inline ` #` starts a comment, matching every dotenv reader. A `#` with no leading
  // space is part of the value (URLs and generated secrets contain one).
  const comment = value.search(/\s#/)
  return (comment === -1 ? value : value.slice(0, comment)).trim()
}

/** Parse dotenv text into a plain record. Later assignments to the same key win, as in a shell. */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue
    const match = ASSIGNMENT.exec(line)
    if (match === null) continue
    values[match[1] as string] = unquote(match[2] as string)
  }
  return values
}

/**
 * Pull every `--env-file <path>` / `--env-file=<path>` out of `argv`, leaving the rest for the command
 * parser (which rejects options it does not know). Repeatable; later files override earlier ones, the
 * same precedence `node --env-file` uses.
 */
export function takeEnvFileFlags(argv: readonly string[]): {
  readonly argv: readonly string[]
  readonly files: readonly string[]
} {
  const rest: string[] = []
  const files: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index] as string
    if (token === ENV_FILE_FLAG) {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith("-")) {
        throw new Error(`[nifra] ${ENV_FILE_FLAG} needs a path, e.g. ${ENV_FILE_FLAG} .env.local`)
      }
      files.push(value)
      index++
      continue
    }
    if (token.startsWith(`${ENV_FILE_FLAG}=`)) {
      const value = token.slice(ENV_FILE_FLAG.length + 1)
      if (value === "") {
        throw new Error(`[nifra] ${ENV_FILE_FLAG} needs a path, e.g. ${ENV_FILE_FLAG}=.env.local`)
      }
      files.push(value)
      continue
    }
    rest.push(token)
  }
  return { argv: rest, files }
}

/**
 * Read each file in order and merge it into `process.env`, never overwriting a variable the process
 * already has. Returns the resolved paths that were applied so a command can say what it loaded.
 */
export async function applyEnvFiles(
  cwd: string,
  files: readonly string[],
): Promise<readonly string[]> {
  const applied: string[] = []
  const merged: Record<string, string> = {}
  for (const file of files) {
    const path = resolve(cwd, file)
    let text: string
    try {
      text = await readFile(path, "utf8")
    } catch {
      throw new Error(`[nifra] --env-file not found or unreadable: ${path}`)
    }
    // Files merge left to right, so a later `--env-file` overrides an earlier one; the merged result
    // is applied afterwards so that precedence never depends on which file happened to define a key.
    Object.assign(merged, parseEnvFile(text))
    applied.push(path)
  }
  for (const [key, value] of Object.entries(merged)) {
    if (process.env[key] === undefined) process.env[key] = value
  }
  return applied
}
