/**
 * Where an app's own entry files live, in one place for every command.
 *
 * - `nifra.config.ts` - the CLI's config (dev/build tooling); only the CLI imports it.
 * - `backend/framework.ts` - the render adapter and the options the generated server entry imports,
 *   kept free of build tooling because it is bundled into every server build.
 * - `backend/app.ts` - exports `backend`, the app's API (a `@nifrajs/core` server). Optional.
 */
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

export const CONFIG_FILE = "nifra.config.ts"
export const FRAMEWORK_FILE = "backend/framework.ts"
export const BACKEND_APP_FILE = "backend/app.ts"

/** The root files this layout retired, and where each lives now. */
export const RETIRED_ROOT_FILES: Readonly<Record<string, string>> = {
  "backend.ts": BACKEND_APP_FILE,
  "framework.ts": FRAMEWORK_FILE,
}

/** Outside a routed app, what made each retired root file the app's: else it is just a module. */
const RETIRED_EXPORTS: Readonly<Record<string, RegExp>> = {
  "backend.ts":
    /\bexport\s+(?:const|let|var|(?:async\s+)?function|class)\s+backend\b|\bexport\s*\{[^}]*\bbackend\b/,
  "framework.ts":
    /\bexport\s+(?:const|let|var|(?:async\s+)?function|class)\s+adapter\b|\bexport\s*\{[^}]*\badapter\b/,
}

function exportsRetiredName(path: string, pattern: RegExp | undefined): boolean {
  if (!existsSync(path)) return false
  try {
    return pattern === undefined || pattern.test(readFileSync(path, "utf8"))
  } catch {
    // Unreadable: the commands that would load it fail too, so report it rather than skip it.
    return true
  }
}

/**
 * The retired root files present in `cwd`, each with where it lives now. The old loader imported them
 * whatever they exported, so in an app with `routes/` or a config each one counts; elsewhere only one
 * that exports what the loader read does, and a library's `backend.ts` module does not.
 */
export function retiredRootFiles(cwd: string): ReadonlyArray<readonly [string, string]> {
  const routed = ["routes", CONFIG_FILE, FRAMEWORK_FILE].some((entry) =>
    existsSync(resolve(cwd, entry)),
  )
  return Object.entries(RETIRED_ROOT_FILES).filter(([file]) =>
    exportsRetiredName(resolve(cwd, file), routed ? undefined : RETIRED_EXPORTS[file]),
  )
}

/** Refuse an app still on the retired root files: run against it, a command would silently miss them. */
export function assertCurrentLayout(cwd: string): void {
  const retired = retiredRootFiles(cwd)
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
