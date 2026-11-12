import type { CssLoadingMode } from "./css-contract.ts"
export interface BuildManifest {
  /** URL of the client entry module (content-hashed). */
  readonly entry: string
  /** URLs of every emitted asset (entry + chunks) - for serving + preloading. */
  readonly assets: readonly string[]
  /** `routeId → [layout chunk URLs…, own chunk URL]` - the chunks a route needs, for `createWebApp`'s
   * `routePreload` (`<link rel="modulepreload">` the matched route alongside the entry). Each route +
   * layout is also a build entrypoint, so it gets a named chunk the bootstrap's lazy import dedupes to. */
  readonly routes: Readonly<Record<string, readonly string[]>>
  /** URL paths copied from `publicDir`, sorted. Lets the server entry serve them without scanning a
   * directory per request, and lets an adapter that needs a file list (CDN upload, platform static
   * assets) consume one. Omitted when there is no `public/`. */
  readonly publicFiles?: readonly string[]
  /** The app's bundled, content-hashed stylesheet(s) - the bootstrap's **aggregate** CSS (every
   * `import './x.css'` reachable from the app). The complete stylesheet regardless of which file
   * imported the CSS; the always-safe fallback `createWebApp` links when a route has no per-route entry
   * in {@link routeStyles}. Omitted when the app imports no CSS. */
  readonly css?: readonly string[]
  /** Whether the Vite client build kept CSS split by entry/chunk. Absent for the native Bun build. */
  readonly cssCodeSplit?: boolean
  /** How framework-owned SSR stylesheet links should become active. Defaults to `blocking`. */
  readonly cssLoading?: CssLoadingMode
  /** `routeId → [chain CSS URLs]` - only the stylesheets the matched route's layout chain + own file
   * actually use (Bun emits a per-entrypoint CSS bundle per route/layout, with shared-component CSS
   * inlined into each consumer). `createWebApp` links these instead of the aggregate, so a page ships
   * only its own CSS. A route is omitted (→ aggregate fallback) when its `[name]` collides with another
   * route's basename (ambiguous CSS↔route) or the build emitted orphan shared-chunk CSS - correctness
   * over minimality. Absent entirely when the app imports no CSS. */
  readonly routeStyles?: Readonly<Record<string, readonly string[]>>
  /** Locale key -> URL of the chunk holding that locale's copy (`@nifrajs/i18n/copy`), when the build
   * moved copy tables out of the bundle. The server entry passes it to `createWebApp`. */
  readonly copyChunks?: Readonly<Record<string, string>>
}

/** The built worker bundle - point your `wrangler.toml`'s `main` at `worker`. */
export interface ServerBuild {
  /** Path to the bundled, self-contained worker entry. */
  readonly worker: string
  /** Paths of every emitted output (entry + any code-split chunks) - what to ship to the platform. */
  readonly outputs: readonly string[]
}

export * from "./internal/client-graph-guards.ts"
export * from "./internal/manifest-drift.ts"
export * from "./internal/size-report.ts"
export * from "./internal/target-plan.ts"
