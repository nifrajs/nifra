/**
 * Zero-config app discovery. The CLI reads a few conventions from the project root:
 *   - `routes/`         — the file-based routes (per `@nifrajs/web/fs`).
 *   - `nifra.config.ts`  — the CLI's framework wiring (see {@link NifraFramework}); `framework.ts` is
 *                         used as a fallback. One of the two is required.
 *   - `backend.ts`      — exports `backend` (a `@nifrajs/core` server, the contract). Optional.
 *
 * Why two filenames: a multi-target app's edge entry (`_worker.ts`) imports `framework.ts` for the
 * render adapter, so `framework.ts` must stay edge-bundlable — it can't reference Vite plugins or the
 * SFC compiler (Bun would pull them into the `target:"browser"` worker and fail on `child_process`).
 * `nifra.config.ts` holds that build/dev tooling instead: it's imported ONLY by this CLI (which runs on
 * Bun), so its Vite plugin + SFC-compiler imports (`@vitejs/plugin-vue`, `@nifrajs/web-vue/plugin`) never
 * reach the edge bundle. A simple single-target app with no edge build can put it all in `framework.ts`.
 */
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { checkPipelineSeparation } from "./pipeline-guard.ts"

/**
 * A plugin list — either an array, or a **thunk** that returns one (optionally async). Both forms are
 * accepted; {@link resolvePlugins} normalizes them. The thunk is just a convenience for deferring a
 * plugin's construction — it does NOT make a plugin edge-safe (Bun.build follows a dynamic `import()`
 * even from an unused export, so a Vite/compiler import in an edge-bundled file fails regardless). Edge
 * safety comes from WHERE the config lives: keep these fields in `nifra.config.ts` (CLI-only), not in
 * the edge-imported `framework.ts`. See the module header.
 */
export type PluginsField =
  | readonly unknown[]
  | (() => readonly unknown[] | Promise<readonly unknown[]>)

/**
 * The CLI's framework wiring — exported from `nifra.config.ts` (or `framework.ts` as a fallback).
 * `create-nifra` generates it. Only `adapter` + `clientModule` are required; the plugin/condition
 * fields are framework-specific extras (Vue/Svelte/Solid need them; React/Preact don't).
 */
export interface NifraFramework {
  /** The render adapter, e.g. `reactAdapter` from `@nifrajs/web-react`. */
  readonly adapter: unknown
  /** The client runtime module providing `mountRouter`, e.g. `"@nifrajs/web-react/client"`. */
  readonly clientModule: string
  /** Vite plugins for `nifra dev`'s HMR, e.g. `[react()]` / `() => import("@vitejs/plugin-vue")…`. */
  readonly vitePlugins?: PluginsField
  /** Bun build plugins that compile routes for the CLIENT bundle (`nifra build`), e.g.
   * `[vueBunPlugin("dom")]`. React/Preact JSX is Bun-native → none. */
  readonly clientPlugins?: PluginsField
  /** Bun runtime plugins that compile routes for SSR — `nifra dev` (Bun-native route import) and
   * `nifra start` register them via `Bun.plugin`, e.g. `[vueBunPlugin("ssr")]`. React/Preact → none. */
  readonly serverPlugins?: PluginsField
  /** Extra Bun.build / Vite resolve conditions, e.g. Solid's `["solid"]`. */
  readonly conditions?: readonly string[]
  /** Compile-time `define` replacements, e.g. Vue's `__VUE_*` flags. */
  readonly define?: Readonly<Record<string, string>>
  /** Static files directory. Defaults to `<app>/public`; `false` disables it. */
  readonly publicDir?: string | false
  /** Client-visible environment prefix (default `"PUBLIC_"`; empty disables exposure). */
  readonly publicEnvPrefix?: string
}

/**
 * Refuse a config that puts one pipeline's plugins into the other's slot.
 *
 * Checked here rather than in `nifra check`, which holds a deliberate pre-`loadApp` invariant - reading
 * plugins means importing the app's config, which is code execution. This runs at the moment the app
 * IS loaded, so `dev`, `build` and `start` are all covered from one place, immediately before the
 * plugins are handed to a bundler.
 *
 * Throws rather than warns. A misplaced plugin does not fail the build: Bun.build has no `transform`
 * hook and Vite never calls `setup`, so the wrong-slot plugin is accepted and silently never invoked -
 * the transform just does not happen, and the output looks plausible. A loud stop with the exact move
 * is strictly better than a build that succeeds and omits the work. The classifier only fires on a
 * decisive hook shape, so a plugin it cannot place is left alone.
 */
function assertPipelineSeparation(plugins: ResolvedPlugins, configFile: string): void {
  const mismatches = checkPipelineSeparation(plugins)
  if (mismatches.length === 0) return
  throw new Error(
    `[nifra] ${configFile}: plugins are in the wrong pipeline slot. nifra supports Vite and Bun, but a phase is owned by ONE of them - a plugin in the wrong slot is silently never called.\n\n` +
      mismatches.map((m) => `  - ${m.fix}`).join("\n"),
  )
}

/** Normalize a {@link PluginsField} (array | thunk | undefined) to a fresh array, awaiting a thunk. */
export async function resolvePlugins(field: PluginsField | undefined): Promise<unknown[]> {
  const value = typeof field === "function" ? await field() : field
  return value ? [...value] : []
}

export interface ResolvedPlugins {
  readonly vitePlugins: readonly unknown[]
  readonly clientPlugins: readonly unknown[]
  readonly serverPlugins: readonly unknown[]
}

export interface LoadedApp {
  readonly cwd: string
  readonly routesDir: string
  /** Build output dir (also where `nifra start` reads `manifest.json` + serves `/assets/*`). */
  readonly outDir: string
  readonly framework: NifraFramework
  /** Plugin thunks resolved exactly once during app loading and reused by every command phase. */
  readonly resolvedPlugins: ResolvedPlugins
  /** The `backend` export from `backend.ts`, or `undefined` if there's no `backend.ts`. */
  readonly backend: unknown
}

export interface LoadAppOptions {
  /** Optional dynamic-import query used by long-lived MCP processes to bust Bun's module cache. */
  readonly importQuery?: string
}

/**
 * Root-level monorepo config — exported from `nifra.config.ts` at the workspace root.
 * Each key in `apps` is the short name used to namespace MCP tools (`nifra_<name>_context` etc.);
 * each value is a path relative to the root that contains its own `nifra.config.ts` / `framework.ts`.
 *
 * Example:
 * ```ts
 * // nifra.config.ts (workspace root)
 * export const apps = {
 *   dashboard: "./apps/dashboard",
 *   portal:    "./apps/portal",
 * }
 * ```
 */
export interface NifraMonorepoConfig {
  readonly apps: Readonly<Record<string, string>>
}

/**
 * Detect whether `cwd` is a monorepo root: has `nifra.config.ts` that exports `apps`, but no
 * `routes/` directory (so it's not itself a nifra app). Returns the `apps` map if so, else `null`.
 */
export async function detectMonorepo(
  cwd: string,
  options: LoadAppOptions = {},
): Promise<NifraMonorepoConfig | null> {
  const configPath = resolve(cwd, "nifra.config.ts")
  if (!existsSync(configPath) || existsSync(resolve(cwd, "routes"))) return null
  const mod = (await import(
    options.importQuery ? `${configPath}?${options.importQuery}` : configPath
  ).catch(() => null)) as Partial<NifraMonorepoConfig> | null
  if (!mod || typeof mod.apps !== "object" || mod.apps === null) return null
  return { apps: mod.apps as Record<string, string> }
}

/**
 * Load all apps declared in a monorepo config. Returns `{ name, cwd, app }[]` in declaration order.
 * Individual app load failures throw — each app must be valid.
 */
export async function loadMonorepoApps(
  rootCwd: string,
  config: NifraMonorepoConfig,
): Promise<Array<{ name: string; cwd: string }>> {
  return Object.entries(config.apps).map(([name, rel]) => ({
    name,
    cwd: resolve(rootCwd, rel),
  }))
}

const isAdapter = (v: unknown): boolean => typeof v === "object" && v !== null

const importWithQuery = (path: string, query: string | undefined): Promise<unknown> =>
  import(query === undefined || query === "" ? path : `${path}?${query}`)

/** Discover + validate the app conventions rooted at `cwd`. Prefers `nifra.config.ts`, falls back to
 * `framework.ts`. Throws a clear, actionable error if neither exists or the config is malformed. */
export async function loadApp(
  cwd: string,
  outDirName = "dist",
  options: LoadAppOptions = {},
): Promise<LoadedApp> {
  // nifra.config.ts is the CLI's config (it may import Vite plugins / the SFC compiler, which a
  // multi-target app keeps OUT of the edge-imported framework.ts). framework.ts is the fallback for a
  // simple single-target app that has no edge build.
  const configFile = existsSync(resolve(cwd, "nifra.config.ts"))
    ? "nifra.config.ts"
    : "framework.ts"
  const configPath = resolve(cwd, configFile)
  if (!existsSync(configPath)) {
    throw new Error(
      `[nifra] no nifra.config.ts or framework.ts found in ${cwd}.\n` +
        "      nifra is zero-config but needs one of them exporting at least:\n" +
        "        export const adapter = reactAdapter            // from @nifrajs/web-react\n" +
        '        export const clientModule = "@nifrajs/web-react/client"\n' +
        "      (create-nifra scaffolds this for you.)",
    )
  }
  if (!existsSync(resolve(cwd, "routes"))) {
    throw new Error(
      `[nifra] no routes/ directory in ${cwd} — nifra apps are file-routed under routes/.`,
    )
  }
  const fw = (await importWithQuery(configPath, options.importQuery)) as Partial<NifraFramework>
  if (!isAdapter(fw.adapter) || typeof fw.clientModule !== "string") {
    throw new Error(
      `[nifra] ${configFile} must export \`adapter\` (a render adapter object) and \`clientModule\` (a string).`,
    )
  }
  const [vitePlugins, clientPlugins, serverPlugins] = await Promise.all([
    resolvePlugins(fw.vitePlugins),
    resolvePlugins(fw.clientPlugins),
    resolvePlugins(fw.serverPlugins),
  ])
  const resolvedPlugins = { vitePlugins, clientPlugins, serverPlugins }
  assertPipelineSeparation(resolvedPlugins, configFile)

  let backend: unknown
  const backendPath = resolve(cwd, "backend.ts")
  if (existsSync(backendPath)) {
    backend = ((await importWithQuery(backendPath, options.importQuery)) as { backend?: unknown })
      .backend
  }

  return {
    cwd,
    routesDir: resolve(cwd, "routes"),
    outDir: resolve(cwd, outDirName),
    framework: fw as NifraFramework,
    resolvedPlugins,
    backend,
  }
}
