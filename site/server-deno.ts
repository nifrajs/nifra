/**
 * The site on Deno - the same Nifra app, served by `@nifrajs/deno` (Deno.serve under the hood). The
 * adapter's `static` answers the machine surfaces and the client bundle under `/assets/` (read with
 * `Deno.readFile`) ahead of every route.
 *
 *   deno run --allow-net --allow-read --allow-env site/dist-deno/server-deno.js   (built by build-deno.ts)
 */
import { inProcessClient } from "@nifrajs/client"
import { contentTypeOf } from "@nifrajs/core/static-file"
import { serve } from "@nifrajs/deno"
import { createWebApp } from "@nifrajs/web"
import { reactAdapter } from "@nifrajs/web-react"
import { backend } from "./backend/app"
import { machineSurfaceFor } from "./backend/machine-surfaces"
import { clientEntry, manifest } from "./server-manifest"

const app = createWebApp({
  adapter: reactAdapter,
  manifest,
  clientEntry,
  api: inProcessClient(backend),
  title: "nifra",
})

const ASSETS_DIR = new URL("./assets/", import.meta.url)

// Each segment is a plain name, never `.` or `..`, so the path stays inside ASSETS_DIR.
const safeSegment = (segment: string): boolean =>
  segment !== "." && segment !== ".." && /^[A-Za-z0-9._-]+$/.test(segment)

async function asset(name: string): Promise<Response> {
  if (!name.split("/").every(safeSegment)) return new Response("bad request", { status: 400 })
  try {
    const body = await Deno.readFile(new URL(name, ASSETS_DIR))
    return new Response(body, { headers: { "content-type": contentTypeOf(name) } })
  } catch {
    return new Response("not found", { status: 404 })
  }
}

await serve(app, {
  port: Number(Deno.env.get("PORT") ?? "3000"),
  static(req) {
    const machineSurface = machineSurfaceFor(req)
    if (machineSurface !== undefined) return machineSurface
    const { pathname } = new URL(req.url)
    return pathname.startsWith("/assets/") ? asset(pathname.slice("/assets/".length)) : undefined
  },
})
