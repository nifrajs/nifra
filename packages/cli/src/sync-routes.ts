/**
 * `nifra sync-routes` - regenerate the route-search types (`nifra-routes.d.ts`) from the current `routes/`
 * tree, so `navigate({ to, search })` is typed against each static route's `searchSchema`. It runs
 * `@nifrajs/web`'s `generateRouteSearchTypes` over the discovered routes and writes the `.d.ts` at the
 * project root; include it in your tsconfig's `include`. Because it is regenerated from the route files, a
 * stale navigate search shape becomes a `tsc` error - run it after adding/renaming a route or changing a
 * `searchSchema` (a pure file write, no build). A dynamic route (`:param`/catch-all) is omitted, since its
 * pattern is not a concrete `to`; those keep the loose object form.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"

/** The committed route-types file `sync-routes` writes, so `nifra check` can recognise + drift-check it. */
export const ROUTE_TYPES_FILE = "nifra-routes.d.ts"

export interface SyncRoutesResult {
  /** The written `.d.ts` (relative to the project root). */
  readonly file: string
  /** True when the file's content changed and it was rewritten. */
  readonly changed: boolean
  /** How many static routes got a typed entry. */
  readonly typedRoutes: number
}

/**
 * Generate the route-search types `.d.ts` from `<cwd>/routes` (the nifra convention). Returns `null` when
 * there is no `routes/` directory (an API-only project - nothing to type). Never loads `framework.ts`: it
 * needs only the route tree, so it works before a build and on a broken framework config.
 */
export async function syncRouteTypes(cwd: string): Promise<SyncRoutesResult | null> {
  const routesDir = join(cwd, "routes")
  if (!existsSync(routesDir)) return null
  const { discoverRoutes } = await import("@nifrajs/web/fs")
  const { generateRouteSearchTypes } = await import("@nifrajs/web")
  const manifest = discoverRoutes(routesDir)
  const code = generateRouteSearchTypes(manifest, {
    // A route file is relative to routesDir (`reports.tsx`, `users/index.tsx`); the `.d.ts` sits at the
    // project root, so the `typeof import(...)` specifier is `./routes/<file без extension>`.
    resolve: (file) => `./routes/${file.replace(/\.[^./]+$/, "")}`,
  })
  const outFile = join(cwd, ROUTE_TYPES_FILE)
  const existing = await Bun.file(outFile)
    .text()
    .catch(() => "")
  const changed = existing !== code
  if (changed) await Bun.write(outFile, code)
  return { file: ROUTE_TYPES_FILE, changed, typedRoutes: (code.match(/: SearchOf</g) ?? []).length }
}

/** CLI entry: write/refresh the route-types file and print a one-line summary + the tsconfig reminder. */
export async function runSyncRoutes(cwd: string): Promise<boolean> {
  const result = await syncRouteTypes(cwd)
  if (result === null) {
    console.log("nifra sync-routes: no routes/ directory found. Run from your project root.")
    return true
  }
  const n = result.typedRoutes
  const routes = `${n} typed route${n === 1 ? "" : "s"}`
  console.log(
    result.changed
      ? `✓ wrote ${result.file} (${routes})`
      : `• ${result.file} already in sync (${routes})`,
  )
  console.log(
    "  Include it in your tsconfig's `include` so `navigate({ to, search })` is typed per route.",
  )
  return true
}
