/**
 * `--shell tauri`: what a site scaffold adds so its pages can ship inside a Tauri 2 shell. The shell
 * project itself comes from `shell-files.ts`, the copy of what `nifra shell tauri` writes; this module
 * adds what only a fresh scaffold can: the server's side (CORS for the shell origins as the web app's `use` hook in `backend/framework.ts`, and the demo route's action origins) and
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

const SHELL_ORIGINS_FILE = `// The origins a native shell's pages are served from. \`backend/framework.ts\` lets them call this server.
// Tauri uses tauri://localhost on macOS, iOS and Linux and http://tauri.localhost on Windows and
// Android; the dev entry is the page \`tauri dev\` loads from \`nifra dev\`.
export const SHELL_ORIGINS: readonly string[] = [
  "tauri://localhost",
  "http://tauri.localhost",
  ...(process.env.NODE_ENV === "production" ? [] : ["http://localhost:${SHELL_DEV_PORT}"]),
]
`

const FRAMEWORK_IMPORTS = `import { cors } from "@nifrajs/middleware"
import { SHELL_ORIGINS } from "./shell-origins"
`
const ADAPTER_EXPORT = "export const adapter ="

/** The response headers the client router reads: CORS hides every header but a few from a page on another
 * origin, and \`*\` does not cover a credentialed request, so they are named. */
const EXPOSED_HEADERS = ["x-nifra-redirect", "x-nifra-status", "x-nifra-revalidate"]

const INDEX_ANCHOR = 'import { t } from "@nifrajs/schema"'
const INDEX_IMPORT = 'import { SHELL_ORIGINS } from "../backend/shell-origins"'
const INDEX_ALLOWED = `
// A shell posts this route's form from its own origin. \`allowedOrigins\` replaces the same-origin default,
// so the site's own posts are admitted through \`sameOrigin\`.
export const allowedOrigins = (origin: string | null, sameOrigin: boolean): boolean =>
  sameOrigin || (origin !== null && SHELL_ORIGINS.includes(origin))
`

const USE_HOOK = `
// A native shell calls this server from its own origin. The web app answers page data and form posts
// (backend/app.ts only serves what \`apiPrefix\` mounts), so the CORS goes on the web app, here.
// Cookie sessions also need \`credentials: true\` below and \`credentials: "include"\` in the shell's
// transport (frontend/shell-transport.ts).
export const use = (app: { use: (plugin: ReturnType<typeof cors>) => unknown }): void => {
  app.use(cors({ origin: SHELL_ORIGINS, exposedHeaders: ${JSON.stringify(EXPOSED_HEADERS)} }))
}
`

/** Write the shell project and wire the backend to accept it. Throws when the template's `framework.ts` is no
 * longer the text this edits, so a template change cannot silently scaffold a shell the server refuses. */
export async function writeShellFiles(dir: string, appName: string): Promise<void> {
  const spec = resolveShellSpec({ packageName: appName })
  for (const [path, content] of shellFiles(spec)) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), content)
  }
  await writeFile(join(dir, "backend/shell-origins.ts"), SHELL_ORIGINS_FILE)
  const frameworkPath = join(dir, "backend/framework.ts")
  const framework = await readFile(frameworkPath, "utf8")
  if (!framework.includes(ADAPTER_EXPORT)) {
    throw new Error(
      "--shell tauri: the template's backend/framework.ts changed; update scaffold/shell.ts",
    )
  }
  await writeFile(
    frameworkPath,
    `${framework.replace(ADAPTER_EXPORT, `${FRAMEWORK_IMPORTS}\n${ADAPTER_EXPORT}`).trimEnd()}\n${USE_HOOK}`,
  )
  const indexPath = join(dir, "routes/index.backend.ts")
  const index = await readFile(indexPath, "utf8")
  if (!index.includes(INDEX_ANCHOR)) {
    throw new Error(
      "--shell tauri: the template's routes/index.backend.ts changed; update scaffold/shell.ts",
    )
  }
  await writeFile(
    indexPath,
    `${index.replace(INDEX_ANCHOR, `${INDEX_ANCHOR}\n${INDEX_IMPORT}`).trimEnd()}\n${INDEX_ALLOWED}`,
  )
  await appendFile(
    join(dir, ".gitignore"),
    `\n# the static build a native shell wraps\n${SHELL_DIST}/\n`,
  )
}
