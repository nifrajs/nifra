/**
 * The partial prerendering fixture: a real `createWebApp` with `ppr`, its client built by
 * `buildClient` and its shells checked by `compileShells` at start. `startPprApp()` serves it on
 * 127.0.0.1 and returns its origin; `app-browser.ts` drives it. Each other framework's twin, in
 * `web-<name>/test/fixtures/ppr-app/server.ts`, passes its own `PprFixtureSetup` and exports a `PprTwin`.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { reactAdapter } from "@nifrajs/web-react"
import { buildClient } from "../../../../src/build.ts"
import { discoverRoutes } from "../../../../src/fs.ts"
import { compileShells } from "../../../../src/internal/ppr/compile-shell.ts"
import type { RenderAdapter } from "../../../../src/render-seam.ts"
import { countCancel, type FixtureOptions, fixtureApp, type PreparedPprApp } from "./app.ts"

export { DRAFT_SECRET } from "./app.ts"

export interface PprApp {
  readonly origin: string
  readonly shellFailures: ReadonlyArray<readonly [string, string]>
  readonly warnings: readonly string[]
  /** The warnings so far, for an app served by another process; `warnings` otherwise. */
  readWarnings?(): Promise<readonly string[]>
  stop(): Promise<void>
}

/** A twin module's exports, as `app-browser.ts` loads them. */
export interface PprTwin {
  startPprApp(options?: undefined, routesDir?: string): Promise<PprApp>
  /**
   * The Trusted Types policy the framework's client creates for its own templates, "" for none, or
   * `null` when the client writes raw HTML outside any policy, so no app on it can enforce them.
   */
  readonly trustedTypesPolicy: string | null
}

/** React's client creates no policy. */
export const trustedTypesPolicy: string | null = ""

/** What differs between the framework twins of this app; the routes, ids and texts do not. */
export interface PprFixtureSetup {
  readonly routesDir: string
  readonly adapter: RenderAdapter
  readonly clientModule: string
  readonly clientPlugins: readonly import("bun").BunPlugin[]
  readonly serverPlugins: readonly import("bun").BunPlugin[]
}

export const REACT: PprFixtureSetup = {
  routesDir: `${import.meta.dir}/routes`,
  adapter: reactAdapter,
  clientModule: "@nifrajs/web-react/client",
  clientPlugins: [],
  serverPlugins: [],
}

/** Builds the client and checks the shells, once per app start. */
export async function preparePprApp(setup: PprFixtureSetup = REACT): Promise<PreparedPprApp> {
  const { routesDir } = setup
  const outDir = mkdtempSync(join(tmpdir(), "nifra-ppr-app-"))
  const assets = await buildClient({
    routesDir,
    outDir,
    clientModule: setup.clientModule,
    conditions: ["bun", "browser"],
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: setup.clientPlugins,
  })
  const shellFailures: Array<readonly [string, string]> = []
  const shellChecks = await compileShells({
    routesDir,
    manifest: discoverRoutes(routesDir),
    deployment: assets.entry,
    requestScoped: (id) => id.endsWith("/ppr/app/lib/session.backend.ts"),
    plugins: setup.serverPlugins,
    onFailure: (routeId, error) =>
      shellFailures.push([routeId, error instanceof Error ? error.message : String(error)]),
  })
  return {
    routesDir,
    outDir,
    assets,
    shellChecks,
    shellFailures,
  }
}

export async function startPprApp(
  setup: PprFixtureSetup = REACT,
  options: FixtureOptions = {},
): Promise<PprApp> {
  const prepared = await preparePprApp(setup)
  const warnings: string[] = []
  const warn = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "))
  }
  const app = fixtureApp(prepared, setup.adapter, options)
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      countCancel(request)
      return app.fetch(request)
    },
  })
  return {
    origin: `http://127.0.0.1:${server.port}`,
    shellFailures: prepared.shellFailures,
    warnings,
    async stop() {
      await server.stop(true)
      console.warn = warn
      rmSync(prepared.outDir, { recursive: true, force: true })
    },
  }
}
