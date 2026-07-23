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
   * changing value to bust Bun's module cache so SSR picks up edited route files. Ignored when
   * {@link load} is supplied, which does its own cache handling. */
  readonly importQuery?: string
  /**
   * Load a route module by its absolute path, instead of a bare dynamic `import()`.
   *
   * This is what lets a pipeline own SSR resolution. A bare `import()` always resolves through the
   * RUNTIME - Bun - so the Vite dev server ended up serving the client while Bun resolved the server,
   * two resolvers disagreeing about one specifier in a single process. That is the dual-React bug and
   * the reason `resolve.dedupe` never reached SSR: the alias governs Vite, and SSR never asked Vite.
   *
   * Pass `vite.ssrLoadModule` here and the Vite pipeline resolves both halves. Omit it and Bun does,
   * which is correct for the Bun pipeline. Either way one toolchain owns the phase.
   */
  readonly load?: (absolutePath: string) => Promise<unknown>
}

/** Scan a `routes/` directory (recursively) and build the route manifest. */
export function discoverRoutes(dir: string, options: DiscoverRoutesOptions = {}): Manifest {
  const files = (readdirSync(dir, { recursive: true }) as string[])
    .map((file) => file.replaceAll("\\", "/")) // normalize Windows separators
    .filter((file) => /\.(tsx|jsx|svelte|vue|mdx)$/.test(file))
  const query = options.importQuery ? `?${options.importQuery}` : ""
  const load = options.load
  return buildManifest(files, (file) =>
    load === undefined
      ? () => import(`${dir}/${file}${query}`) as Promise<RouteModule>
      : // No `importQuery` here: an injected loader owns its own invalidation (Vite's module graph
        // re-evaluates on change), and appending a cache-buster would defeat it by minting a new
        // module id per request.
        () => load(`${dir}/${file}`) as Promise<RouteModule>,
  )
}
