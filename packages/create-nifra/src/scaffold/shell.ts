/**
 * `--shell tauri`: what a site scaffold adds so its pages can ship inside a Tauri 2 shell. The shell
 * project itself comes from `shell-files.ts`, the copy of what `nifra shell tauri` writes; this module
 * adds what only a fresh scaffold can: the server's side (CORS for the shell origins, in `backend/`) and
 * the package scripts.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { resolveShellSpec, SHELL_DEV_PORT, SHELL_DIST, shellFiles } from "../shell-files.ts"
import type { FeatureContribution } from "./features.ts"

/** The Tauri CLI, pinned: the version the generated `src-tauri/` project was written against. */
export const TAURI_CLI_VERSION = "2.12.4"

export const SHELL_FEATURE: FeatureContribution = {
  label: "--shell tauri",
  devDependencies: { "@tauri-apps/cli": TAURI_CLI_VERSION },
  scripts: { "shell:dev": "tauri dev", "shell:build": "tauri build" },
}

const SHELL_ORIGINS_FILE = `// The origins a native shell's pages are served from. \`backend/app.ts\` lets them call this server.
// Tauri uses tauri://localhost on macOS, iOS and Linux and http://tauri.localhost on Windows and
// Android; the dev entry is the page \`tauri dev\` loads from \`nifra dev\`.
export const SHELL_ORIGINS: readonly string[] = [
  "tauri://localhost",
  "http://tauri.localhost",
  ...(process.env.NODE_ENV === "production" ? [] : ["http://localhost:${SHELL_DEV_PORT}"]),
]
`

const CORS_BEFORE = `    cors({
      origin: process.env.CORS_ORIGIN ?? "http://localhost:3000",
      credentials: false,
    }),`
const CORS_AFTER = `    cors({
      origin: [process.env.CORS_ORIGIN ?? "http://localhost:3000", ...SHELL_ORIGINS],
      exposedHeaders: ["*"],
      credentials: false,
    }),`
const COUNTER_IMPORT = 'import { counter } from "./counter"'

/** Write the shell project and wire the backend to accept it. Throws when the template's `app.ts` is no
 * longer the text this edits, so a template change cannot silently scaffold a shell the server refuses. */
export async function writeShellFiles(dir: string, appName: string): Promise<void> {
  const spec = resolveShellSpec({ packageName: appName })
  for (const [path, content] of shellFiles(spec)) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), content)
  }
  await writeFile(join(dir, "backend/shell-origins.ts"), SHELL_ORIGINS_FILE)
  const appPath = join(dir, "backend/app.ts")
  const app = await readFile(appPath, "utf8")
  if (!app.includes(CORS_BEFORE) || !app.includes(COUNTER_IMPORT)) {
    throw new Error(
      "--shell tauri: the template's backend/app.ts changed; update scaffold/shell.ts",
    )
  }
  await writeFile(
    appPath,
    app
      .replace(CORS_BEFORE, CORS_AFTER)
      .replace(
        COUNTER_IMPORT,
        `${COUNTER_IMPORT}\nimport { SHELL_ORIGINS } from "./shell-origins"`,
      ),
  )
  await appendFile(
    join(dir, ".gitignore"),
    `\n# the static build a native shell wraps\n${SHELL_DIST}/\n`,
  )
}
