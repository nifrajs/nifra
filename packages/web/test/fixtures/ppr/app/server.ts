/**
 * The G6 Phase 1a fixture: a real `createWebApp` with `experimental.ppr`, its client built by
 * `buildClient` and its shells checked by `compileShells` at start. `startPprApp()` serves it on
 * 127.0.0.1 and returns its origin; `app-browser.ts` drives it.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { reactAdapter } from "../../../../../web-react/src/index.ts"
import { buildClient } from "../../../../src/build.ts"
import { createCspPolicy } from "../../../../src/csp.ts"
import { discoverRoutes } from "../../../../src/fs.ts"
import { compileShells } from "../../../../src/internal/ppr/compile-shell.ts"
import { createWebApp } from "../../../../src/internal/web-app.ts"
import { probe } from "./lib/probe.ts"

export interface PprApp {
  readonly origin: string
  readonly shellFailures: ReadonlyArray<readonly [string, string]>
  readonly warnings: readonly string[]
  stop(): Promise<void>
}

export async function startPprApp(): Promise<PprApp> {
  const routesDir = `${import.meta.dir}/routes`
  const outDir = mkdtempSync(join(tmpdir(), "nifra-ppr-app-"))
  const assets = await buildClient({
    routesDir,
    outDir,
    clientModule: "@nifrajs/web-react/client",
    conditions: ["bun", "browser"],
    define: { "process.env.NODE_ENV": '"production"' },
  })
  const manifest = discoverRoutes(routesDir)
  const shellFailures: Array<readonly [string, string]> = []
  const shellChecks = await compileShells({
    routesDir,
    manifest,
    deployment: assets.entry,
    requestScoped: (id) => id.endsWith("/ppr/app/lib/session.ts"),
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
    adapter: reactAdapter,
    manifest,
    clientEntry: assets.entry,
    routePreload: assets.routes,
    styles: assets.css ?? [],
    csp,
    experimental: { ppr: { shellChecks, origin: "https://shop.example" } },
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
