/**
 * The fixture's app on any runtime. `server.ts` builds its client and checks its shells with Bun, then
 * serves this app with Bun, or hands the build to `deno-server.ts`, which serves it with Deno.
 */
import { readFile } from "node:fs/promises"
import { compression } from "@nifrajs/middleware"
import type { BuildManifest } from "../../../../src/build-plan.ts"
import { createCspPolicy } from "../../../../src/csp.ts"
import { discoverRoutes } from "../../../../src/fs.ts"
import type { ShellCheckRecord } from "../../../../src/internal/ppr/compile-shell.ts"
import { createWebApp } from "../../../../src/internal/web-app.ts"
import { type PprOptions, partialPrerendering } from "../../../../src/ppr.ts"
import type { RenderAdapter } from "../../../../src/render-seam.ts"
import { probe, releaseHeld } from "./lib/probe.ts"

/** Signs the fixture's draft cookies; a test value, as `enableDraft` documents. */
export const DRAFT_SECRET = "ppr-fixture-draft-secret-not-for-production"

/** A client build and its shell checks, as `preparePprApp` in `server.ts` makes them. */
export interface PreparedPprApp {
  readonly routesDir: string
  readonly outDir: string
  readonly assets: Pick<BuildManifest, "entry" | "routes" | "css">
  readonly shellChecks: ShellCheckRecord
  readonly shellFailures: ReadonlyArray<readonly [string, string]>
}

export interface FixtureOptions {
  readonly compress?: boolean
  readonly pprOptions?: PprOptions
}

export function fixtureApp(
  prepared: PreparedPprApp,
  adapter: RenderAdapter,
  { compress = false, pprOptions }: FixtureOptions = {},
) {
  const { assets, outDir } = prepared
  const csp = createCspPolicy({
    header: ({ sources }) =>
      `default-src 'self'; script-src 'self' ${sources}; style-src 'self'; object-src 'none'; base-uri 'none'`,
  })
  const app = createWebApp({
    adapter,
    manifest: discoverRoutes(prepared.routesDir),
    clientEntry: assets.entry,
    routePreload: assets.routes,
    styles: assets.css ?? [],
    csp,
    draftSecret: DRAFT_SECRET,
    ppr: partialPrerendering({
      shellChecks: prepared.shellChecks,
      origin: "https://shop.example",
      options: pprOptions ?? {},
    }),
  })
  app.get("/assets/*", async (c) => {
    const name = new URL(c.req.url).pathname.slice("/assets/".length)
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return new Response("Bad Request", { status: 400 })
    const bytes = await readFile(`${outDir}/${name}`).catch(() => undefined)
    if (bytes === undefined) return new Response("Not Found", { status: 404 })
    const type = name.endsWith(".css")
      ? "text/css; charset=utf-8"
      : "text/javascript; charset=utf-8"
    return new Response(bytes, { headers: { "content-type": type } })
  })
  if (compress) app.use(compression())
  app.get("/__probe", () => Response.json({ ...probe, timeOrigin: performance.timeOrigin }))
  app.post("/__release", () => Response.json(releaseHeld()))
  app.get("/__unrelated", async () => {
    await new Promise((resolve) => setTimeout(resolve, 400))
    return new Response("unrelated ok")
  })
  return app
}

/** Counts a cancel beacon before the app sees it; the browser checks read `probe.cancels`. */
export function countCancel(request: Request): void {
  if (request.method === "POST" && request.url.endsWith("/__nifra/ppr/cancel")) probe.cancels++
}
