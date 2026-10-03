/**
 * Where an app's own entry files live, in one place for every command.
 *
 * - `nifra.config.ts` - the CLI's config (dev/build tooling); only the CLI imports it.
 * - `backend/framework.ts` - the render adapter and the options the generated server entry imports,
 *   kept free of build tooling because it is bundled into every server build.
 * - `backend/app.ts` - exports `backend`, the app's API (a `@nifrajs/core` server). Optional.
 */
import { existsSync } from "node:fs"
import { stat } from "node:fs/promises"
import { resolve } from "node:path"

export const CONFIG_FILE = "nifra.config.ts"
export const FRAMEWORK_FILE = "backend/framework.ts"
export const BACKEND_APP_FILE = "backend/app.ts"

/** The root files this layout retired, and where each lives now. */
export const RETIRED_ROOT_FILES: Readonly<Record<string, string>> = {
  "backend.ts": BACKEND_APP_FILE,
  "framework.ts": FRAMEWORK_FILE,
}

/** Refuse an app still on the retired root files: run against it, a command would silently miss them. */
export function assertCurrentLayout(cwd: string): void {
  const retired = Object.entries(RETIRED_ROOT_FILES).filter(([file]) =>
    existsSync(resolve(cwd, file)),
  )
  if (retired.length === 0) return
  const moves = retired.map(([from, to]) => `${from} -> ${to}`).join(", ")
  throw new Error(
    `[nifra] this app uses the retired root layout (${moves}). Run \`nifra migrate layout\` to see the ` +
      "move (it also splits each route into x.tsx and x.backend.ts), then `nifra migrate layout --write`.",
  )
}

/** The file the generated server entry imports the adapter from: `backend/framework.ts` when it exists,
 * else the config (a single-target app may keep everything in `nifra.config.ts`). */
export function adapterFile(cwd: string): string {
  const framework = resolve(cwd, FRAMEWORK_FILE)
  return existsSync(framework) ? framework : resolve(cwd, CONFIG_FILE)
}

/** `mtime:size` of `path`, or `missing`: what a long-lived process compares to notice an edit. */
export async function fileFingerprint(path: string): Promise<string> {
  try {
    const s = await stat(path)
    return `${s.mtimeMs}:${s.size}`
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
      return "missing"
    }
    throw err
  }
}
