/**
 * `@nifrajs/web/build` — the production build (Bun-only, build-time). `buildClient` codegens + bundles
 * the client entry (content-hashed, code-split); `buildServer` codegens the static-import server
 * manifest + bundles a self-contained **worker** for the disk-less edge (Cloudflare Workers). Both
 * are Bun-specific and never on the request path (own subpath, like `@nifrajs/web/fs`); the *output*
 * runs on any runtime.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, relative, resolve as resolvePath } from "node:path"
import type { BunPlugin } from "bun"
import { sanitizeOutputNames } from "./chunk-names.ts"
import { discoverRoutes } from "./fs.ts"
import { generateClientEntry, generateServerManifest } from "./index.ts"

// Build-time SSG: prerender opted-in static + dynamic routes to `index.html` (+ static `_data.json`),
// run after `buildClient`.
export {
  type CloudflarePagesRoutes,
  type CloudflarePagesRoutesOptions,
  cloudflarePagesRoutes,
  dataFileFor,
  htmlFileFor,
  type PrerenderApp,
  type PrerenderEntry,
  type PrerenderOptions,
  type PrerenderResult,
  prerenderRoutes,
} from "./prerender.ts"

export interface BuildClientOptions {
  /** The `routes/` directory to discover (absolute path). */
  readonly routesDir: string
  /** Output directory for the bundle + `manifest.json` (absolute path). */
  readonly outDir: string
  /** The adapter's client runtime (exports `mountRouter`), e.g. `"@nifrajs/web-solid/client"`. */
  readonly clientModule: string
  /** Route/layout file → import specifier (default: `${routesDir}/${file}`). */
  readonly resolve?: (file: string) => string
  /** Adapter build plugins (e.g. `solidBunPlugin("dom")`). */
  readonly plugins?: readonly BunPlugin[]
  /** `Bun.build` export conditions (e.g. `["bun", "solid", "browser"]`). */
  readonly conditions?: readonly string[]
  /** Compile-time replacements (e.g. `{ "process.env.NODE_ENV": '"production"' }`). */
  readonly define?: Readonly<Record<string, string>>
  /** Minify the output (default `true`). */
  readonly minify?: boolean
  /** URL prefix the assets are served under (default `"/assets/"`); also Bun's chunk `publicPath`. */
  readonly publicPath?: string
}

/** The built asset map — the server reads `entry` for the client script + serves `assets`. */
export interface BuildManifest {
  /** URL of the client entry module (content-hashed). */
  readonly entry: string
  /** URLs of every emitted asset (entry + chunks) — for serving + preloading. */
  readonly assets: readonly string[]
  /** `routeId → [layout chunk URLs…, own chunk URL]` — the chunks a route needs, for `createWebApp`'s
   * `routePreload` (`<link rel="modulepreload">` the matched route alongside the entry). Each route +
   * layout is also a build entrypoint, so it gets a named chunk the bootstrap's lazy import dedupes to. */
  readonly routes: Readonly<Record<string, readonly string[]>>
  /** The app's bundled, content-hashed stylesheet(s) — the bootstrap's **aggregate** CSS (every
   * `import './x.css'` reachable from the app). The complete stylesheet regardless of which file
   * imported the CSS; the always-safe fallback `createWebApp` links when a route has no per-route entry
   * in {@link routeStyles}. Omitted when the app imports no CSS. */
  readonly css?: readonly string[]
  /** `routeId → [chain CSS URLs]` — only the stylesheets the matched route's layout chain + own file
   * actually use (Bun emits a per-entrypoint CSS bundle per route/layout, with shared-component CSS
   * inlined into each consumer). `createWebApp` links these instead of the aggregate, so a page ships
   * only its own CSS. A route is omitted (→ aggregate fallback) when its `[name]` collides with another
   * route's basename (ambiguous CSS↔route) or the build emitted orphan shared-chunk CSS — correctness
   * over minimality. Absent entirely when the app imports no CSS. */
  readonly routeStyles?: Readonly<Record<string, readonly string[]>>
}

/** The slice of Bun's build metafile nifra reads: per JS output, its source `entryPoint` + the
 * `cssBundle` Bun emitted for that entry. Used to map each route file → its stylesheet (collision-safe,
 * keyed by source path). Not yet in `@types/bun`; shape per the Bun bundler docs. */
interface BunMetafile {
  readonly outputs: Readonly<
    Record<string, { readonly entryPoint?: string; readonly cssBundle?: string }>
  >
}

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1)
/** `[name]` Bun derives for an entrypoint: basename without extension (`users/[id].tsx` → `[id]`). */
const entryName = (file: string): string => {
  const base = basename(file)
  const dot = base.lastIndexOf(".")
  return dot === -1 ? base : base.slice(0, dot)
}

/**
 * Build the client bundle for a file-routed app. Writes the hashed assets + `manifest.json` to
 * `outDir` and returns the manifest. Throws (with the bundler logs) on build failure — never
 * silently ships a broken bundle.
 */
export async function buildClient(options: BuildClientOptions): Promise<BuildManifest> {
  const { routesDir, outDir, clientModule } = options
  const resolve = options.resolve ?? ((file: string) => `${routesDir}/${file}`)
  const publicPath = options.publicPath ?? "/assets/"
  mkdirSync(outDir, { recursive: true })

  const routeManifest = discoverRoutes(routesDir)
  // The bootstrap's filename is `_velo`-namespaced (not `entry.ts`) so its `[name]` can't collide with
  // a user route named `entry.tsx` when the CSS mapping below excludes the bootstrap's aggregate CSS.
  const mode = options.minify === false ? "development" : "production"
  const entryFile = `${outDir}/_nifra-entry.ts`
  // A client bundle has no Node `process`; provide a minimal one so a stray bare `process` reference in
  // an app module doesn't crash hydration (`process.env.*` reads are handled at compile time by `define`).
  writeFileSync(
    entryFile,
    `globalThis.process ??= { env: {} };\n${generateClientEntry(routeManifest, { clientModule, resolve })}`,
  )

  // Every unique route/layout/`_404` file (sorted, stable), as ADDITIONAL entrypoints — Bun emits a
  // named chunk per file that the bootstrap's lazy `import()` dedupes to (verified), so the manifest
  // can map each route to its chunk URLs for matched-route preload. `resolve(file)` is the same
  // specifier the bootstrap imports, so the entrypoint + lazy import are the same module (dedup).
  const routeFiles = [
    ...new Set([
      ...routeManifest.routes.map((r) => r.file),
      ...Object.values(routeManifest.layouts).map((l) => l.file),
      ...(routeManifest.notFound ? [routeManifest.notFound.file] : []),
    ]),
  ].sort()

  // `metafile: true` asks Bun for the input/output graph — specifically `outputs[js].entryPoint`
  // (the source file) + `outputs[js].cssBundle` (that entry's emitted stylesheet). It's the robust
  // entry→CSS link for per-route splitting: keyed by the unique source path, so it survives
  // same-basename collisions (`index.tsx` + `blog/index.tsx`) that a filename match can't. Not yet in
  // `@types/bun`'s `BuildConfig`, so spread it in (spread props skip the excess-property check).
  const buildExtras = { metafile: true }
  const result = await Bun.build({
    entrypoints: [entryFile, ...routeFiles.map(resolve)],
    outdir: outDir,
    target: "browser",
    naming: "[name]-[hash].[ext]",
    publicPath,
    splitting: true, // one chunk per lazily-imported route; shared deps deduped into shared chunks
    // `import "./x.css"` in a route/component → bundled, minified, content-hashed `.css` asset (Bun
    // strips the import from the JS; CSS bundling is on by default since Bun 1.2). Mapped to routes
    // below — both the aggregate and per-route — via the metafile, for `<link>` injection.
    ...buildExtras,
    minify: options.minify ?? true,
    plugins: [...(options.plugins ?? [])],
    ...(options.conditions ? { conditions: [...options.conditions] } : {}),
    // Replace `process.env.*` at compile time so an app module reading config off `process.env` doesn't
    // hit a `process is not defined` crash in the browser. Bun does longest-match: NODE_ENV resolves to
    // the build mode (React's prod/dev branch); every other `process.env.X` becomes undefined. Callers
    // can override either via `options.define`.
    define: {
      "process.env": "({})",
      "process.env.NODE_ENV": JSON.stringify(mode),
      ...options.define,
    },
  })
  if (!result.success) {
    throw new Error(
      `[nifra/web] client build failed:\n${result.logs.map((l) => String(l)).join("\n")}`,
    )
  }

  // Rename any chunk whose basename isn't URL-safe (dynamic-route files become `[slug]-hash.js`) and
  // rewrite the references — otherwise the lazy import 404s and the route silently never hydrates.
  const renamed = sanitizeOutputNames(result.outputs)
  const toUrl = (path: string): string =>
    `${publicPath}${renamed.get(basename(path)) ?? basename(path)}`
  // Entry-point outputs come back in entrypoint order: [bootstrap, ...routeFiles]. Map each route file
  // to its chunk URL by that order (guarded against drift), then a route's chunks = its layout chain +
  // own file.
  const entryPoints = result.outputs.filter((o) => o.kind === "entry-point")
  const bootstrap = entryPoints[0]
  if (bootstrap === undefined) throw new Error("[nifra/web] build produced no entry-point output")
  if (entryPoints.length !== routeFiles.length + 1) {
    throw new Error(
      `[nifra/web] expected ${routeFiles.length + 1} entry-point outputs (bootstrap + ${routeFiles.length} routes), got ${entryPoints.length}`,
    )
  }
  const fileToChunk = new Map<string, string>()
  routeFiles.forEach((file, i) => {
    const out = entryPoints[i + 1] // in range — length checked above
    if (out !== undefined) fileToChunk.set(file, toUrl(out.path))
  })
  const chunksFor = (chainFiles: readonly string[]): string[] =>
    chainFiles.map((f) => fileToChunk.get(f)).filter((u): u is string => u !== undefined)
  const routes: Record<string, string[]> = {}
  for (const route of routeManifest.routes) {
    routes[route.id] = chunksFor([
      ...route.layoutIds.map((id) => routeManifest.layouts[id]?.file ?? ""),
      route.file,
    ])
  }
  if (routeManifest.notFound) routes._404 = chunksFor([routeManifest.notFound.file])

  // CSS — aggregate: an `import "./x.css"` anywhere → a content-hashed `.css` asset (Bun strips the
  // import from the JS). The bootstrap lazily imports every route, so its **aggregate** stylesheet is
  // the whole app's CSS — the always-safe fallback `createWebApp` links when a route has no per-route
  // entry below. Fallback to all CSS assets if Bun emitted no distinct aggregate.
  const bootstrapName = entryName(entryFile) // `_nifra-entry`
  const cssNameOf = (path: string): string => {
    const base = basename(path)
    return base.slice(0, base.lastIndexOf("-")) // strip `-${hash}.css`
  }
  const cssAssets = result.outputs.filter((o) => o.kind === "asset" && o.path.endsWith(".css"))
  const aggregate = cssAssets
    .filter((o) => cssNameOf(o.path) === bootstrapName)
    .map((o) => toUrl(o.path))
  const css: readonly string[] =
    aggregate.length > 0 ? aggregate : cssAssets.map((o) => toUrl(o.path))

  // CSS — per-route: each route/layout file is its own entrypoint, so the build metafile records its
  // `cssBundle` — exactly the CSS that file's subtree uses (shared-component CSS is inlined into each
  // consumer; verified). Keyed by the metafile's unique source `entryPoint`, so it survives
  // same-basename collisions (`index.tsx` + `blog/index.tsx`) that a filename match can't. A page then
  // links only its layout chain + own CSS (deduped); an empty array means the page needs no CSS at all.
  // Absent (→ aggregate fallback) only if Bun emits no metafile/cssBundle — never silently incomplete.
  const meta = (result as unknown as { metafile?: BunMetafile }).metafile
  const cwd = process.cwd()
  const cssByEntry = new Map<string, string>()
  for (const out of Object.values(meta?.outputs ?? {})) {
    if (out.entryPoint !== undefined && out.cssBundle !== undefined) {
      cssByEntry.set(resolvePath(cwd, out.entryPoint), toUrl(out.cssBundle))
    }
  }
  const stylesFor = (chainFiles: readonly string[]): readonly string[] => {
    const urls = chainFiles
      .map((f) => (f ? cssByEntry.get(resolvePath(resolve(f))) : undefined))
      .filter((u): u is string => u !== undefined)
    return [...new Set(urls)]
  }
  const routeStyles: Record<string, readonly string[]> = {}
  if (css.length > 0 && cssByEntry.size > 0) {
    for (const route of routeManifest.routes) {
      routeStyles[route.id] = stylesFor([
        ...route.layoutIds.map((id) => routeManifest.layouts[id]?.file ?? ""),
        route.file,
      ])
    }
    if (routeManifest.notFound) routeStyles._404 = stylesFor([routeManifest.notFound.file])
  }

  const manifest: BuildManifest = {
    entry: toUrl(bootstrap.path),
    assets: result.outputs.map((o) => toUrl(o.path)),
    routes,
    ...(css.length > 0 ? { css } : {}),
    ...(Object.keys(routeStyles).length > 0 ? { routeStyles } : {}),
  }
  writeFileSync(`${outDir}/manifest.json`, JSON.stringify(manifest, null, 2))
  return manifest
}

export interface BuildServerOptions {
  /** The `routes/` directory to discover (absolute path). */
  readonly routesDir: string
  /** The worker entry module (absolute path) — your `worker.ts`. It imports `{ manifest, clientEntry }`
   * from the generated `./server-manifest`, builds `createWebApp`, and `export default toFetchHandler(app)`. */
  readonly serverEntry: string
  /** Output directory for the bundled worker (absolute path). */
  readonly outDir: string
  /** The content-hashed client entry URL (from `buildClient`'s manifest) — **baked** into the generated
   * server manifest, since a disk-less worker can't read `manifest.json` at runtime. */
  readonly clientEntry: string
  /** Route/layout file → import specifier in the generated manifest (default: a relative path from the
   * manifest's location — written next to `serverEntry` — to `routesDir`). */
  readonly resolve?: (file: string) => string
  /** Filename for the generated server-manifest module, written next to `serverEntry` (default
   * `"server-manifest.ts"`); your `serverEntry` imports it as `./server-manifest`. */
  readonly manifestFile?: string
  /** Adapter build plugins (e.g. `solidBunPlugin("ssr")` — Solid routes need their SSR transform at
   * build time; React's JSX is Bun-native and needs none). */
  readonly plugins?: readonly BunPlugin[]
  /** `Bun.build` resolution conditions (default `["workerd", "edge-light", "browser"]`) — selects each
   * dependency's edge build. */
  readonly conditions?: readonly string[]
  /** Compile-time replacements (default `{ "process.env.NODE_ENV": '"production"' }` → production
   * React/Solid on the edge). Pass an explicit object to override (e.g. `{}` to opt out). */
  readonly define?: Readonly<Record<string, string>>
  /** Minify the output (default `true`). */
  readonly minify?: boolean
  /** `Bun.build` target (default `"browser"` — the right shape for edge runtimes: Cloudflare Workers,
   * Vercel Edge, Deno, Deno Deploy). Use `"node"` for a `@nifrajs/node` server (so `node:*` built-ins
   * stay external), or `"bun"` for a Bun server. The default `conditions` + the edge resolve shims
   * only apply to the `"browser"` target; `"node"`/`"bun"` resolve their own renderer builds via the
   * matching condition. */
  readonly target?: "browser" | "node" | "bun"
  /** **Lazy/code-split routes** (default `false`): emit `() => import(route)` loaders + bundle with
   * `splitting`, so each route is its own chunk loaded on first request (smaller cold-start parse)
   * instead of all parsed at boot. The output becomes the worker entry **+ chunk files** in `outDir`
   * — on Cloudflare, ship them with wrangler's `no_bundle` + `find_additional_modules` + an ESModule
   * `rule` (Node/Deno import the chunks natively). Eager (one self-contained file) stays the default. */
  readonly lazy?: boolean
}

/** The built worker bundle — point your `wrangler.toml`'s `main` at `worker`. */
export interface ServerBuild {
  /** Path to the bundled, self-contained worker entry. */
  readonly worker: string
  /** Paths of every emitted output (entry + any code-split chunks) — what to ship to the platform. */
  readonly outputs: readonly string[]
}

/**
 * react-dom's `exports["./server"]` maps the `bun` condition to a Bun-API server build that crashes
 * on workerd, and `Bun.build` always applies the `bun` condition (it wins over `workerd`/`edge-light`),
 * so conditions alone can't select the edge build. This shim pins `react-dom/server` to its edge build
 * (`server.edge.js`, which exports `renderToReadableStream`). A no-op when nothing imports react-dom
 * (e.g. a Solid worker) — the resolver only runs on a match.
 */
const reactDomEdgePlugin = (from: string): BunPlugin => ({
  name: "nifra-react-dom-edge",
  setup(build) {
    build.onResolve({ filter: /^react-dom\/server$/ }, () => ({
      path: Bun.resolveSync("react-dom/server.edge", from),
    }))
  },
})

/**
 * `solid-js/web` selects its **server** runtime (`renderToStream`) via the `worker` condition, but
 * `Bun.build` 1.3.14 **segfaults** when the `worker` condition is active (https://bun.report). And
 * without `worker`, `browser` (which precedes the other server conditions in solid's exports map)
 * wins → the *dom* runtime, which can't SSR. So this shim pins `solid-js/web` straight to its server
 * build, sidestepping the crashing condition. Lazy (resolved on match) + a no-op when nothing imports
 * `solid-js/web` (e.g. a React worker). Drop it (and use the `worker` condition) once Bun is fixed.
 */
const solidWebServerPlugin = (from: string): BunPlugin => ({
  name: "nifra-solid-web-server",
  setup(build) {
    build.onResolve({ filter: /^solid-js\/web$/ }, () => {
      // solid's `worker`/`node`/`deno` conditions all map to ./web/dist/server.js (its server build).
      const pkg = Bun.resolveSync("solid-js/package.json", from)
      return { path: pkg.replace(/package\.json$/, "web/dist/server.js") }
    })
  },
})

/**
 * Build a self-contained **worker bundle** for a file-routed app on a disk-less edge (Cloudflare
 * Workers / workerd). Discovers routes (build-time fs), codegens the static-import server manifest
 * (`generateServerManifest`, written next to `serverEntry`), then bundles `serverEntry` with
 * `Bun.build` using **edge conditions** + the adapter's SSR plugins. The output imports no `node:fs`
 * and does no dynamic-path import, so it runs on workerd: point `wrangler.toml`'s `main` at it and
 * serve the client assets via Workers Assets. Throws (with the bundler logs) on failure — never
 * silently ships a broken worker.
 */
export async function buildServer(options: BuildServerOptions): Promise<ServerBuild> {
  const { routesDir, serverEntry, outDir, clientEntry } = options
  const entryDir = dirname(serverEntry)
  const manifestFile = options.manifestFile ?? "server-manifest.ts"
  // Default: import routes relative from the generated manifest (next to serverEntry) to routesDir.
  const rel = relative(entryDir, routesDir).replaceAll("\\", "/")
  const resolve = options.resolve ?? ((file: string) => `./${rel}/${file}`)
  mkdirSync(outDir, { recursive: true })

  const lazy = options.lazy ?? false
  const target = options.target ?? "browser"
  // Edge (browser) target: Bun's `bun` condition contaminates react-dom's server build + the `worker`
  // condition segfaults Bun.build on solid, so force the edge/server builds via shims. The `node`/`bun`
  // targets resolve those correctly via their own condition, so the shims (and edge conditions) don't
  // apply — defaults become `[target]` (e.g. react-dom → server.node.js under `node`).
  const edge = target === "browser"
  const conditions = options.conditions ?? (edge ? ["workerd", "edge-light", "browser"] : [target])
  const manifest = discoverRoutes(routesDir)
  writeFileSync(
    `${entryDir}/${manifestFile}`,
    generateServerManifest(manifest, { resolve, clientEntry, lazy }),
  )

  const result = await Bun.build({
    entrypoints: [serverEntry],
    outdir: outDir,
    target,
    conditions: [...conditions],
    define: { ...(options.define ?? { "process.env.NODE_ENV": '"production"' }) },
    minify: options.minify ?? true,
    // Lazy → one chunk per route (loaded on first request); eager → a single self-contained file.
    splitting: lazy,
    plugins: [
      ...(edge ? [reactDomEdgePlugin(entryDir), solidWebServerPlugin(entryDir)] : []),
      ...(options.plugins ?? []),
    ],
  })
  if (!result.success) {
    throw new Error(
      `[nifra/web] server build failed:\n${result.logs.map((l) => String(l)).join("\n")}`,
    )
  }
  const entryOutput = result.outputs.find((o) => o.kind === "entry-point")
  if (entryOutput === undefined) {
    throw new Error("[nifra/web] server build produced no entry-point output")
  }
  return { worker: entryOutput.path, outputs: result.outputs.map((o) => o.path) }
}
