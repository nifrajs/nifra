/**
 * `nifra types`: the generated `./+types/<route>` modules (see `@nifrajs/web/route-types`), plus the one
 * tsconfig line that lets routes import them. `nifra dev`, `nifra build` and `nifra check` refresh them
 * too, so a fresh checkout type-checks without running this by hand.
 */
import { existsSync, readFileSync, watch } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { ROUTE_TYPES_DIR, staleRouteTypes, writeRouteTypes } from "@nifrajs/web/route-types"
import { stripComments } from "./check-scan.ts"

export interface RouteTypesReport {
  readonly ok: boolean
  readonly check: boolean
  /** Files written (or, with `check`, that would be). */
  readonly written: readonly string[]
  readonly removed: readonly string[]
  /** With `check`: every generated file missing, out of date, or no longer generated. */
  readonly stale: readonly string[]
  /** Set when tsconfig does not merge `.nifra/types` in through `rootDirs`. */
  readonly tsconfig?: string
}

const TSCONFIG_HINT = `add "rootDirs": [".", "./${ROUTE_TYPES_DIR}"] to compilerOptions in tsconfig.json, so a route can import ./+types/<name>`

/** A tsconfig's JSONC as an object, following relative `extends`, or `undefined` when unreadable. */
function readTsconfig(
  path: string,
  depth = 0,
): { compilerOptions?: Record<string, unknown> } | undefined {
  if (depth > 8 || !existsSync(path)) return undefined
  try {
    const text = stripComments(readFileSync(path, "utf8")).replace(/,(\s*[}\]])/g, "$1")
    const config = JSON.parse(text) as {
      extends?: unknown
      compilerOptions?: Record<string, unknown>
    }
    if (config.compilerOptions?.rootDirs !== undefined || typeof config.extends !== "string") {
      return config
    }
    if (!config.extends.startsWith(".")) return config
    const base = config.extends.endsWith(".json") ? config.extends : `${config.extends}.json`
    const parent = readTsconfig(resolve(dirname(path), base), depth + 1)
    return { compilerOptions: { ...parent?.compilerOptions, ...config.compilerOptions } }
  } catch {
    return undefined
  }
}

/** Why the app's tsconfig cannot resolve `./+types/<name>`, or `undefined` when it can. */
export function routeTypesTsconfigIssue(appRoot: string): string | undefined {
  const tsconfig = join(appRoot, "tsconfig.json")
  if (!existsSync(tsconfig)) return undefined
  const rootDirs = readTsconfig(tsconfig)?.compilerOptions?.rootDirs
  const merged =
    Array.isArray(rootDirs) &&
    rootDirs.some(
      (dir) =>
        typeof dir === "string" && resolve(appRoot, dir) === resolve(appRoot, ROUTE_TYPES_DIR),
    )
  return merged ? undefined : TSCONFIG_HINT
}

const appRelative = (appRoot: string, paths: readonly string[]): string[] =>
  paths.map((path) => relative(appRoot, path).replaceAll("\\", "/"))

/** Generate (or, with `check`, verify) an app's route types. */
export function routeTypes(
  appRoot: string,
  options: { readonly check?: boolean } = {},
): RouteTypesReport {
  const tsconfig = routeTypesTsconfigIssue(appRoot)
  const extra = tsconfig === undefined ? {} : { tsconfig }
  if (options.check === true) {
    const stale = appRelative(appRoot, staleRouteTypes({ appRoot }))
    return { ok: stale.length === 0, check: true, written: [], removed: [], stale, ...extra }
  }
  const { written, removed } = writeRouteTypes({ appRoot })
  return {
    ok: true,
    check: false,
    written: appRelative(appRoot, written),
    removed: appRelative(appRoot, removed),
    stale: [],
    ...extra,
  }
}

/**
 * Refresh route types before a command that type-checks or bundles; quiet unless something changed.
 * Never throws: a routes tree the generator cannot read is the command's own error to report.
 */
export function refreshRouteTypes(
  appRoot: string,
  log: (line: string) => void = console.log,
): void {
  if (!existsSync(join(appRoot, "routes"))) return
  let report: RouteTypesReport
  try {
    report = routeTypes(appRoot)
  } catch (error) {
    log(`[nifra] route types: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  const { written, removed, tsconfig } = report
  if (written.length + removed.length > 0) {
    log(
      `[nifra] route types: ${written.length} written, ${removed.length} removed in ${ROUTE_TYPES_DIR}`,
    )
  }
  if (tsconfig !== undefined) log(`[nifra] route types: ${tsconfig}`)
}

/**
 * Keep route types current while `nifra dev` runs: they depend only on which route files exist, so a
 * route added or removed (or `backend/app.ts` appearing) regenerates them. Returns the stop function.
 */
export function watchRouteTypes(appRoot: string): () => void {
  const routes = join(appRoot, "routes")
  if (!existsSync(routes)) return () => {}
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => refreshRouteTypes(appRoot), 50)
  }
  // Not persistent: the dev server's own shutdown must not wait on this watcher.
  const watchers = [watch(routes, { recursive: true, persistent: false }, schedule)]
  const backend = join(appRoot, "backend")
  if (existsSync(backend)) watchers.push(watch(backend, { persistent: false }, schedule))
  return () => {
    clearTimeout(timer)
    for (const watcher of watchers) watcher.close()
  }
}
