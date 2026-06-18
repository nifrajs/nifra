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
}

/** Normalize a {@link PluginsField} (array | thunk | undefined) to a fresh array, awaiting a thunk. */
export async function resolvePlugins(field: PluginsField | undefined): Promise<unknown[]> {
  const value = typeof field === "function" ? await field() : field
  return value ? [...value] : []
}

export interface LoadedApp {
  readonly cwd: string
  readonly routesDir: string
  /** Build output dir (also where `nifra start` reads `manifest.json` + serves `/assets/*`). */
  readonly outDir: string
  readonly framework: NifraFramework
  /** The `backend` export from `backend.ts`, or `undefined` if there's no `backend.ts`. */
  readonly backend: unknown
}

export interface LoadAppOptions {
  /** Optional dynamic-import query used by long-lived MCP processes to bust Bun's module cache. */
  readonly importQuery?: string
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
    backend,
  }
}
