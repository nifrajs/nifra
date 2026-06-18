/**
 * Build-time SSG driver. Prerendering is framework-agnostic by construction: a nifra SSR page is
 * "just `app.fetch(GET)` returning a streamed `Response`", so prerendering = drive that same handler
 * at build with a synthetic request, drain the body to bytes, and write the HTML to disk. No adapter
 * (React/Solid/Vue/Preact/Svelte) is touched — this sits entirely above the render seam.
 *
 * Handles **static** routes (opt in via `export const prerender = true`) and **dynamic** `:param`
 * routes (enumerate concrete params via `export const getStaticPaths`). Catch-all/wildcard (`*`)
 * routes are not supported.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve, sep } from "node:path"
import { fillRoutePattern, type RouteEntry } from "./manifest.ts"
import { DATA_HEADER } from "./router.ts"

/** Minimal app surface the driver needs — just a fetch handler (a built `createWebApp`). */
export interface PrerenderApp {
  fetch(req: Request): Response | Promise<Response>
}

export interface PrerenderOptions {
  /** The built web app (a `createWebApp` result). A synthetic `GET <origin><pattern>` is issued per
   * prerenderable route; its drained response body is written to disk. */
  readonly app: PrerenderApp
  /** The route manifest's `routes`. Only **static** routes whose module exports `prerender === true`
   * are emitted; everything else is recorded in {@link PrerenderResult.skipped} with a reason. */
  readonly routes: readonly RouteEntry[]
  /** Absolute output directory. `<pattern>/index.html` is written under it (`/` → `index.html`). */
  readonly outDir: string
  /** Origin for the synthetic request URL. Default `http://localhost`. Only the path is meaningful;
   * loaders see this as `request.url`, so set it if a loader builds absolute URLs from the origin. */
  readonly origin?: string
}

export interface PrerenderEntry {
  /** The route pattern that was prerendered (e.g. `/`, `/about`). */
  readonly path: string
  /** The written file, relative to `outDir` (e.g. `index.html`, `about/index.html`). */
  readonly file: string
  /** Byte length of the written HTML. */
  readonly bytes: number
  /** The loader-data file written alongside (`<path>/_data.json`) so a client soft-nav INTO this
   * route skips the worker. Absent when the data-mode response is NDJSON (a deferred loader). */
  readonly dataFile?: string
}

export interface PrerenderResult {
  readonly prerendered: readonly PrerenderEntry[]
  readonly skipped: readonly { readonly path: string; readonly reason: string }[]
  /** Per dynamic route pattern, its `getStaticPaths` `fallback` (`"ssr"` default) — so the deploy
   * layer knows whether unlisted paths should hit the worker (`"ssr"`) or 404 (`"404"`). */
  readonly fallbacks: Readonly<Record<string, "ssr" | "404">>
}

/** Map a route path to its output file: `/` → `index.html`, `/a/b` → `a/b/index.html`. */
export function htmlFileFor(pattern: string): string {
  const trimmed = pattern.replace(/^\/+/, "").replace(/\/+$/, "")
  return trimmed === "" ? "index.html" : `${trimmed}/index.html`
}

/** The static loader-data file next to a route's `index.html`: `/` → `_data.json`, `/a/b` →
 * `a/b/_data.json`. The client fetches it on soft-nav into a prerendered route (no worker). */
export function dataFileFor(pattern: string): string {
  return htmlFileFor(pattern).replace(/index\.html$/, "_data.json")
}

const outputPath = (root: string, file: string): string | undefined => {
  const abs = resolve(root, file)
  return abs !== root && abs.startsWith(`${root}${sep}`) ? abs : undefined
}

/**
 * Render every opted-in static route to a static `index.html` under `outDir`. Run AFTER `buildClient`
 * (so the app references the hashed client entry). Returns a report of what was emitted vs skipped —
 * the caller can use `prerendered` to wire a hybrid deploy (e.g. exclude those paths from the SSR
 * worker so the CDN serves the static file). Never throws on a per-route miss: a non-OK response or a
 * non-opted/dynamic route is recorded in `skipped` and the build continues.
 */
export async function prerenderRoutes(options: PrerenderOptions): Promise<PrerenderResult> {
  const origin = options.origin ?? "http://localhost"
  const prerendered: PrerenderEntry[] = []
  const skipped: { path: string; reason: string }[] = []
  const fallbacks: Record<string, "ssr" | "404"> = {}
  const outRoot = resolve(options.outDir)

  // Render one concrete path → drain the streamed document to bytes → write its index.html. Shared by
  // static (one path) and dynamic (one path per getStaticPaths entry) routes; never throws.
  const renderPath = async (path: string): Promise<void> => {
    const res = await options.app.fetch(new Request(`${origin}${path}`))
    if (!res.ok) {
      // A failed render is a per-route skip, not a build failure — surfaced for the caller to log.
      skipped.push({ path, reason: `render returned HTTP ${res.status}` })
      return
    }
    const html = await res.text()
    const file = htmlFileFor(path)
    const abs = outputPath(outRoot, file)
    if (abs === undefined) {
      skipped.push({ path, reason: "unsafe output path" })
      return
    }
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, html)

    // Also emit the loader data as a static `_data.json` next to it, so a client soft-nav into this
    // route fetches a file instead of hitting the worker. Only when the data-mode response is plain
    // JSON — a deferred loader answers with NDJSON, which the static fast-path doesn't cover (the
    // client falls back to the worker for those).
    let dataFile: string | undefined
    const dataRes = await options.app.fetch(
      new Request(`${origin}${path}`, { headers: { [DATA_HEADER]: "1" } }),
    )
    if (
      dataRes.ok &&
      !(dataRes.headers.get("content-type") ?? "").includes("application/x-ndjson")
    ) {
      dataFile = dataFileFor(path)
      const dataAbs = outputPath(outRoot, dataFile)
      if (dataAbs === undefined) {
        await dataRes.body?.cancel()
        dataFile = undefined
      } else {
        writeFileSync(dataAbs, await dataRes.text())
      }
    } else {
      await dataRes.body?.cancel() // not emitting (non-OK or NDJSON) — release the stream
    }

    prerendered.push({ path, file, bytes: html.length, ...(dataFile ? { dataFile } : {}) })
  }

  for (const route of options.routes) {
    if (route.pattern.includes("*")) {
      skipped.push({ path: route.pattern, reason: "catch-all/wildcard route — not supported" })
      continue
    }
    const mod = await route.load()

    if (route.pattern.includes(":")) {
      // Dynamic route → enumerate concrete paths via `getStaticPaths`.
      if (mod.getStaticPaths === undefined) {
        skipped.push({ path: route.pattern, reason: "dynamic route without getStaticPaths" })
        continue
      }
      const { paths, fallback = "ssr" } = await mod.getStaticPaths()
      fallbacks[route.pattern] = fallback
      for (const { params } of paths) {
        const { path, missing } = fillRoutePattern(route.pattern, params)
        if (missing.length > 0) {
          skipped.push({
            path: route.pattern,
            reason: `getStaticPaths missing param(s): ${missing.join(", ")}`,
          })
          continue
        }
        await renderPath(path)
      }
      continue
    }

    // Static route → opt-in flag.
    if (mod.prerender !== true) {
      skipped.push({
        path: route.pattern,
        reason: "not opted in (`export const prerender = true`)",
      })
      continue
    }
    await renderPath(route.pattern)
  }

  return { prerendered, skipped, fallbacks }
}

/** A Cloudflare Pages `_routes.json` document. `exclude`d paths are served straight from the CDN (the
 * Function/worker is NOT invoked); everything else in `include` hits the worker. */
export interface CloudflarePagesRoutes {
  readonly version: 1
  readonly include: readonly string[]
  readonly exclude: readonly string[]
}

export interface CloudflarePagesRoutesOptions {
  /** Prerendered request paths (e.g. `prerenderRoutes(...).prerendered.map(p => p.path)`, or the
   * build's `prerendered.json`). Each is excluded from the worker — plus its static `_data.json`. */
  readonly prerendered: readonly string[]
  /** Extra globs to keep OFF the worker (CDN-served). Default `["/assets/*"]` (the hashed bundle). */
  readonly staticGlobs?: readonly string[]
}

/**
 * Build a Cloudflare Pages `_routes.json` for a HYBRID SSG deploy: the prerendered HTML + their static
 * `_data.json` + the asset bundle are `exclude`d (CDN serves them directly), and everything else falls
 * through to the SSR `_worker.js`. Write the result to `dist/_routes.json`.
 *
 * ⚠️ Cloudflare caps `_routes.json` at **100** include+exclude rules total, and each prerendered path
 * costs 2 (the doc + its `_data.json`). For a large SSG site, exclude by **prefix glob** (e.g.
 * `/blog/*`) instead of listing every path — pass those via `staticGlobs` and a smaller `prerendered`.
 */
export function cloudflarePagesRoutes(
  options: CloudflarePagesRoutesOptions,
): CloudflarePagesRoutes {
  const exclude = [...(options.staticGlobs ?? ["/assets/*"])]
  for (const path of options.prerendered) {
    exclude.push(path) // the prerendered document
    exclude.push(path === "/" ? "/_data.json" : `${path.replace(/\/+$/, "")}/_data.json`) // its data
  }
  return { version: 1, include: ["/*"], exclude }
}
