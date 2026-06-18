/**
 * @nifrajs/web/fs — filesystem route discovery. Separated from the main entry so `app.fetch`
 * (and the rest of @nifrajs/web) stays fs-free + edge-portable: this runs at build/startup
 * only. It scans a routes dir and feeds the pure `buildManifest`.
 */
import { readdirSync } from "node:fs"
import { buildManifest, type Manifest, type RouteModule } from "./manifest.ts"

/** Options for {@link discoverRoutes}. */
export interface DiscoverRoutesOptions {
  /** Appended (as `?<importQuery>`) to each route's dynamic import — the dev server sets a
   * changing value to bust Bun's module cache so SSR picks up edited route files. */
  readonly importQuery?: string
}

/** Scan a `routes/` directory (recursively) and build the route manifest. */
export function discoverRoutes(dir: string, options: DiscoverRoutesOptions = {}): Manifest {
  const files = (readdirSync(dir, { recursive: true }) as string[])
    .map((file) => file.replaceAll("\\", "/")) // normalize Windows separators
    .filter((file) => /\.(tsx|jsx|svelte|vue|mdx)$/.test(file))
  const query = options.importQuery ? `?${options.importQuery}` : ""
  return buildManifest(
    files,
    (file) => () => import(`${dir}/${file}${query}`) as Promise<RouteModule>,
  )
}
