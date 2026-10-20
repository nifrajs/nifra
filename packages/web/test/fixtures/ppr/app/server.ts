/**
 * The G6 Phase 1 fixture: a real `createWebApp` with `experimental.ppr`, its client built by
 * `buildClient` and its shells checked by `compileShells` at start. `startPprApp()` serves it on
 * 127.0.0.1 and returns its origin; `app-browser.ts` drives it. The Svelte twin in
 * `web-svelte/test/fixtures/ppr-app` passes its own `PprFixtureSetup`.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { reactAdapter } from "@nifrajs/web-react"
import { buildClient } from "../../../../src/build.ts"
import { createCspPolicy } from "../../../../src/csp.ts"
import { discoverRoutes } from "../../../../src/fs.ts"
import { compileShells } from "../../../../src/internal/ppr/compile-shell.ts"
import { createWebApp } from "../../../../src/internal/web-app.ts"
import { partialPrerendering } from "../../../../src/ppr.ts"
import type { RenderAdapter } from "../../../../src/render-seam.ts"
import { probe } from "./lib/probe.ts"

export interface PprApp {
  readonly origin: string
  readonly shellFailures: ReadonlyArray<readonly [string, string]>
  readonly warnings: readonly string[]
  stop(): Promise<void>
}

/** What differs between the framework twins of this app; the routes, ids and texts do not. */
export interface PprFixtureSetup {
  readonly routesDir: string
  readonly adapter: RenderAdapter
  readonly clientModule: string
  readonly clientPlugins: readonly import("bun").BunPlugin[]
  readonly serverPlugins: readonly import("bun").BunPlugin[]
}

const REACT: PprFixtureSetup = {
  routesDir: `${import.meta.dir}/routes`,
  adapter: reactAdapter,
  clientModule: "@nifrajs/web-react/client",
  clientPlugins: [],
  serverPlugins: [],
}

export async function startPprApp(setup: PprFixtureSetup = REACT): Promise<PprApp> {
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
  const manifest = discoverRoutes(routesDir)
  const shellFailures: Array<readonly [string, string]> = []
  const shellChecks = await compileShells({
    routesDir,
    manifest,
    deployment: assets.entry,
    requestScoped: (id) => id.endsWith("/ppr/app/lib/session.ts"),
    plugins: setup.serverPlugins,
    onFailure: (routeId, error) =>
      shellFailures.push([routeId, error instanceof Error ? error.message : String(error)]),
  })
  const warnings: string[] = []
  const warn = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "))
  }
  const csp = createCspPolicy({
    header: ({ sources }) =>
      `default-src 'self'; script-src 'self' ${sources}; style-src 'self'; object-src 'none'; base-uri 'none'`,
  })
  const app = createWebApp({
    adapter: setup.adapter,
    manifest,
    clientEntry: assets.entry,
    routePreload: assets.routes,
    styles: assets.css ?? [],
    csp,
    experimental: { ppr: partialPrerendering({ shellChecks, origin: "https://shop.example" }) },
  })
  app.get("/assets/*", async (c) => {
    const name = new URL(c.req.url).pathname.slice("/assets/".length)
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return new Response("Bad Request", { status: 400 })
    const file = Bun.file(`${outDir}/${name}`)
    if (!(await file.exists())) return new Response("Not Found", { status: 404 })
    const type = name.endsWith(".css")
      ? "text/css; charset=utf-8"
      : "text/javascript; charset=utf-8"
    return new Response(file, { headers: { "content-type": type } })
  })
  app.get("/__probe", () => Response.json(probe))
  app.get("/__unrelated", async () => {
    await new Promise((resolve) => setTimeout(resolve, 400))
    return new Response("unrelated ok")
  })
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      if (request.method === "POST" && request.url.endsWith("/__nifra/ppr/cancel")) probe.cancels++
      return app.fetch(request)
    },
  })
  return {
    origin: `http://127.0.0.1:${server.port}`,
    shellFailures,
    warnings,
    async stop() {
      await server.stop(true)
      console.warn = warn
      rmSync(outDir, { recursive: true, force: true })
    },
  }
}
