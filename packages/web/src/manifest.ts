/**
 * Route manifest — the fs-free heart of file-based routing. Maps route file paths to nifra
 * router patterns + their nested layout chain. `discoverRoutes` (in `@nifrajs/web/fs`) scans
 * the filesystem and feeds `buildManifest`; everything here is pure logic, so it stays
 * portable (no fs, no DOM) and fully unit-testable. Edge deploys pre-build the manifest.
 */

/** Context passed to a route `loader`. The `api` + `env` are injected by `createWebApp` and typed
 * per-route via `@nifrajs/client`'s `LoaderArgs<Api, Env>` (here they are opaque to the agnostic core). */
export interface LoaderContext {
  readonly params: Record<string, string>
  readonly request: Request
  readonly api: unknown
  /** Platform bindings forwarded from the request `c.env` (Workers env/KV/D1). Opaque here. */
  readonly env: unknown
  /** `true` when the request carries a valid draft/preview cookie (only when `createWebApp` is given a
   * `draftSecret`; otherwise always `false`). Branch on it to load unpublished content for editors. */
  readonly draft: boolean
}

/** A route's optional data loader: params/request in, data out. */
export type Loader = (ctx: LoaderContext) => unknown | Promise<unknown>

/**
 * A route's optional mutation, run on POST. Shares the loader context (params/request/api);
 * read the form/JSON body off `request`. Returns either a `Response` (e.g. a redirect —
 * passed straight through) or data, surfaced to the page component as `actionData`.
 */
export type Action = (ctx: LoaderContext) => unknown | Promise<unknown>

/** The document head a route contributes — title + `<meta>`/`<link>` tag attribute sets. */
export interface Meta {
  readonly title?: string
  readonly meta?: ReadonlyArray<Record<string, string>>
  readonly link?: ReadonlyArray<Record<string, string>>
}

/** Args for a route's `meta` function: the loader's data + the route params. */
export interface MetaArgs<Data = unknown> {
  readonly data: Data
  readonly params: Record<string, string>
}

/** A route's `meta`: a static {@link Meta}, or a function of the loader data + params. */
export type MetaInput = Meta | ((args: MetaArgs) => Meta)

/** One concrete parameterization of a dynamic route, returned by {@link GetStaticPaths}. */
export interface StaticPath {
  /** Values for the route's `:param` segments, e.g. `{ id: "7" }` for `/users/:id`. */
  readonly params: Record<string, string>
}

/** What a route's `getStaticPaths` returns: the param sets to prerender + the unlisted-path policy. */
export interface StaticPaths {
  readonly paths: readonly StaticPath[]
  /**
   * How a path NOT in `paths` is handled. `"ssr"` (default) → rendered on-demand by the worker
   * (the natural hybrid behavior — an unlisted path simply isn't a static file); `"404"` → only the
   * listed paths exist. Recorded by `prerenderRoutes` for the deploy layer.
   */
  readonly fallback?: "ssr" | "404"
}

/** A dynamic route's build-time param enumeration (the SSG equivalent of "which pages exist"). */
export type GetStaticPaths = () => StaticPaths | Promise<StaticPaths>

/** A route module — the default component + optional loader / action / meta. */
export interface RouteModule {
  readonly default: unknown
  readonly loader?: Loader
  readonly action?: Action
  readonly meta?: MetaInput
  /**
   * Opt this route out of nifra's full-document client hydration. The server still renders the full
   * HTML document, loaders/actions still run, and native links/forms still work; the generated app
   * client, route chunks, and loader globals are omitted for hard navigations. Intended for static or
   * island-hydrated pages where interactivity is mounted by smaller, explicit client entries.
   */
  readonly hydrate?: boolean
  /**
   * Opt a **static** route (no `:param`/`*`) into build-time prerendering (SSG): `prerenderRoutes`
   * (from `@nifrajs/web/build`) renders it to a static `index.html` at build. The loader runs at build
   * with the in-process `api` (build-safe data only — no per-request cookies/secrets); `defer()` on a
   * prerendered route resolves at build. For **dynamic** routes use {@link getStaticPaths} instead.
   */
  readonly prerender?: boolean
  /**
   * Enumerate the concrete params to prerender for a **dynamic** (`:param`) route — the SSG path list
   * (blogs/docs/etc.). Runs at build; `prerenderRoutes` renders one `index.html` per returned path.
   */
  readonly getStaticPaths?: GetStaticPaths
  /**
   * ISR freshness for this route, in **seconds**. `createWebApp` emits it as an `x-nifra-revalidate`
   * response header that `withISR` reads to set the page's cache TTL (overriding the wrapper's
   * default). Older-than-`revalidate` cached pages are served stale while regenerating.
   */
  readonly revalidate?: number
  /**
   * No-framework island bundles (`@nifrajs/web/islands`) to load on this route, as `<script
   * type="module">` in the document tail. Loaded **regardless of `hydrate`** — pair with
   * `export const hydrate = false` for a static page that ships zero framework JS and mounts
   * interactivity through `<Island>` markers + `mountIslands` enhancers instead.
   */
  readonly islandScripts?: readonly string[]
}

/** A layout (or `_404`/`_error`) entry: its source file (for client codegen) + a lazy loader.
 *
 * A `_layout.tsx` may export `meta` (static {@link Meta} or a function of the loader data + params,
 * same shape as a route's) to contribute sitewide `<head>` tags — `hreflang`/`preconnect`/etc. that
 * belong on every page under the layout. The layout chain's heads merge with the page's: arrays
 * (`meta`/`link`) concatenate outermost→innermost→page; scalars (`title`) are nearest-wins (the page
 * overrides an inner layout, which overrides an outer one). See `mergeHeads` in `@nifrajs/web`. */
export interface LayoutEntry {
  readonly file: string
  readonly load: () => Promise<{ default: unknown; meta?: MetaInput }>
}

/** One matched route: pattern, nested layout ids (outermost → innermost), source file, loader. */
export interface RouteEntry {
  readonly id: string
  readonly pattern: string
  readonly layoutIds: readonly string[]
  /** `_error` boundary ids in this route's ancestor chain (outermost → innermost). The last is the
   * **nearest** boundary, rendered when the route's loader throws. Always set by `buildManifest`
   * (optional only so hand-built test manifests may omit it); absent/empty ⇒ no boundary (error 500s). */
  readonly errorIds?: readonly string[]
  readonly file: string
  readonly load: () => Promise<RouteModule>
}

/** The full route manifest. */
export interface Manifest {
  readonly routes: readonly RouteEntry[]
  readonly layouts: Readonly<Record<string, LayoutEntry>>
  /** Per-segment `_error` boundary components, keyed by id (`_error`, `a/_error`, …). Always set by
   * `buildManifest` (optional only so hand-built test manifests may omit it). */
  readonly errors?: Readonly<Record<string, LayoutEntry>>
  readonly notFound?: LayoutEntry
}

// `.svelte` and `.vue` routes are supported too: their `default` export is the component and
// `loader`/`action`/`meta` come from a module-level script block (Svelte `<script module>`, Vue's plain
// `<script>`) as named ESM exports — the same RouteModule shape as `.tsx`. Both compile via their
// package's Bun plugin (`@nifrajs/web-svelte/plugin`, `@nifrajs/web-vue/plugin`).
const ROUTE_EXT = /\.(tsx|jsx|svelte|vue|mdx)$/
const PARAM = /^\[([A-Za-z_][A-Za-z0-9_]*)\]$/
const CATCH_ALL = /^\[\.\.\.([A-Za-z_][A-Za-z0-9_]*)\]$/
// An optional dynamic segment: `[[lang]]` matches with OR without the segment. It expands a file into
// two patterns (`:lang` present / absent), so `[[lang]]/about` serves both `/about` and `/en/about`.
const OPTIONAL = /^\[\[([A-Za-z_][A-Za-z0-9_]*)\]\]$/
// A route group: a `(name)` folder organizes routes (and can hold its own `_layout`) without
// contributing a URL segment — mirrors Next/Remix. Requires content between the parens.
const GROUP = /^\(.+\)$/

const stripExt = (file: string): string => file.replace(ROUTE_EXT, "")
const baseName = (file: string): string => file.slice(file.lastIndexOf("/") + 1)
const dirOf = (file: string): string =>
  file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ""
const layoutIdFor = (dir: string): string => (dir === "" ? "_layout" : `${dir}/_layout`)
const errorIdFor = (dir: string): string => (dir === "" ? "_error" : `${dir}/_error`)

/**
 * Derive **every** nifra router pattern a route file maps to (relative to the routes dir):
 * `index` → the parent path, `[id]` → `:id`, `[...slug]` → `*slug` (catch-all, captures the rest of
 * the path into one param), `(group)` folders are dropped from the URL (organization only), and an
 * optional `[[lang]]` expands the set — once with the segment present (`:lang`) and once absent. A file
 * with no optionals yields exactly one pattern. Throws on an invalid param or a catch-all that isn't
 * the last segment.
 */
export function filePathToPatterns(file: string): string[] {
  // Each combo is a list of URL segments built so far; an optional segment doubles the set.
  let combos: string[][] = [[]]
  const segments = stripExt(file).split("/")
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!
    if (seg === "index") continue
    if (GROUP.test(seg)) continue // route group — no URL segment (its `_layout` still applies, keyed by dir)
    if (seg.startsWith("[")) {
      const catchAll = CATCH_ALL.exec(seg)
      if (catchAll !== null) {
        // The core router requires the wildcard to be the final segment. Enforce it at the file level
        // (ignoring trailing `index`/`(group)`) so the error names the file, not a generated pattern.
        const after = segments.slice(i + 1).filter((s) => s !== "index" && !GROUP.test(s))
        if (after.length > 0) {
          throw new Error(
            `[nifra/web] catch-all "${seg}" must be the last segment in "${file}" (found "${after.join("/")}" after it)`,
          )
        }
        combos = combos.map((c) => [...c, `*${catchAll[1]}`])
        continue
      }
      const optional = OPTIONAL.exec(seg)
      if (optional !== null) {
        // Optional segment: keep each existing combo (absent) AND a copy with `:name` appended (present).
        combos = combos.flatMap((c) => [c, [...c, `:${optional[1]}`]])
        continue
      }
      const match = PARAM.exec(seg)
      if (match === null) {
        throw new Error(
          `[nifra/web] invalid route param in "${file}": "${seg}" must be [name], [[name]], [...name], or a (group) folder`,
        )
      }
      combos = combos.map((c) => [...c, `:${match[1]}`])
    } else {
      combos = combos.map((c) => [...c, seg])
    }
  }
  return combos.map((c) => `/${c.join("/")}`)
}

/**
 * The **canonical** single pattern for a route file — all optional segments present. A file with no
 * optionals yields its one pattern. Use {@link filePathToPatterns} to get every pattern (optionals
 * expand the set).
 */
export function filePathToPattern(file: string): string {
  const patterns = filePathToPatterns(file)
  return patterns[patterns.length - 1]!
}

/** The dir chain from root → the file's own dir, e.g. "a/b/p.tsx" → ["", "a", "a/b"]. */
const ancestorDirs = (file: string): string[] => {
  const dirs = [""]
  const dir = dirOf(file)
  if (dir === "") return dirs
  let acc = ""
  for (const part of dir.split("/")) {
    acc = acc === "" ? part : `${acc}/${part}`
    dirs.push(acc)
  }
  return dirs
}

/**
 * Build a manifest from route file paths (relative to the routes dir) + an `importer` that
 * turns a path into a lazy module loader. Pure — no fs. Throws at boot (the loud-and-early
 * RouteConfigError ethos) on duplicate patterns. `_layout`/`_404`/`_error` files are special; other
 * `_`-prefixed files are ignored (private/colocated, never routed).
 */
export function buildManifest(
  files: readonly string[],
  importer: (file: string) => () => Promise<RouteModule>,
): Manifest {
  const layoutDirs = new Set<string>()
  const layouts: Record<string, LayoutEntry> = {}
  const errorDirs = new Set<string>()
  const errors: Record<string, LayoutEntry> = {}
  let notFound: LayoutEntry | undefined
  const routeFiles: string[] = []

  for (const file of files) {
    const stem = stripExt(baseName(file))
    if (stem === "_layout") {
      const dir = dirOf(file)
      layoutDirs.add(dir)
      layouts[layoutIdFor(dir)] = { file, load: importer(file) }
    } else if (stem === "_error") {
      const dir = dirOf(file)
      errorDirs.add(dir)
      errors[errorIdFor(dir)] = { file, load: importer(file) }
    } else if (stem === "_404") {
      notFound = { file, load: importer(file) }
    } else if (!stem.startsWith("_")) {
      routeFiles.push(file)
    }
  }

  const byPattern = new Map<string, string>()
  const routes: RouteEntry[] = []
  for (const file of routeFiles) {
    const dirs = ancestorDirs(file)
    const layoutIds = dirs.filter((dir) => layoutDirs.has(dir)).map(layoutIdFor)
    const errorIds = dirs.filter((dir) => errorDirs.has(dir)).map(errorIdFor)
    const id = stripExt(file)
    const load = importer(file) // one lazy loader per file, shared by its (possibly expanded) patterns
    // An optional `[[x]]` segment expands a file into multiple patterns, all pointing at the same
    // module (same id/load/layout chain). Distinct patterns ⇒ no match ambiguity (different lengths).
    for (const pattern of filePathToPatterns(file)) {
      const existing = byPattern.get(pattern)
      if (existing !== undefined) {
        throw new Error(
          `[nifra/web] duplicate route: "${file}" and "${existing}" both map to "${pattern}"`,
        )
      }
      byPattern.set(pattern, file)
      routes.push({ id, pattern, layoutIds, errorIds, file, load })
    }
  }

  const base: Manifest = { routes, layouts, errors }
  return notFound === undefined ? base : { ...base, notFound }
}

const FILL_PARAM = /:([A-Za-z_][A-Za-z0-9_]*)/g

const encodeRouteParam = (value: string): string => {
  const encoded = encodeURIComponent(value)
  // `encodeURIComponent(".")` and `encodeURIComponent("..")` intentionally leave dots alone, but those
  // are filesystem path segments during prerender output. Keep them URL-equivalent while making them
  // inert as path components.
  return encoded === "." || encoded === ".." ? encoded.replace(/\./g, "%2E") : encoded
}

/**
 * Substitute a route pattern's `:param` segments with concrete values: `/users/:id` + `{id:"7"}` →
 * `/users/7`. Returns the filled path plus any params that had no value (a `getStaticPaths` bug) so
 * the caller can skip rather than emit a path with a literal `:name`. Shared by the SSG driver and
 * {@link enumeratePrerenderedPaths}.
 */
export function fillRoutePattern(
  pattern: string,
  params: Record<string, string>,
): { path: string; missing: string[] } {
  const missing: string[] = []
  const path = pattern.replace(FILL_PARAM, (_m, name: string) => {
    const value = params[name]
    if (value === undefined) {
      missing.push(name)
      return `:${name}`
    }
    return encodeRouteParam(value)
  })
  return { path, missing }
}

/** The static-routing facts a server needs from the route modules: which concrete paths are
 * prerendered, plus each dynamic route's `getStaticPaths` fallback policy. */
export interface StaticRoutes {
  /** Concrete prerendered paths — static `prerender` routes + each `getStaticPaths` entry. */
  readonly paths: string[]
  /** Per dynamic route pattern, its `getStaticPaths` `fallback` (`"ssr"` default). `createWebApp` uses
   * `"404"` to reject an unlisted path under that route at runtime (the path simply doesn't exist). */
  readonly fallbacks: Record<string, "ssr" | "404">
}

/**
 * Enumerate the static-routing facts `prerenderRoutes` would produce — static routes opted in via
 * `export const prerender = true`, each `getStaticPaths` entry of a dynamic route, and each dynamic
 * route's `fallback` policy. Pure (no rendering), so a server can compute what to hand `createWebApp`
 * (the prerendered set for the client's static-`_data.json` soft-nav + the fallback map for
 * `"404"` enforcement). A production server may instead read the build's `prerendered.json` to avoid
 * loading every route module at startup. Catch-all/wildcard routes and dynamic routes without
 * `getStaticPaths` are omitted from `paths`.
 */
export async function enumerateStaticRoutes(routes: readonly RouteEntry[]): Promise<StaticRoutes> {
  const paths: string[] = []
  const fallbacks: Record<string, "ssr" | "404"> = {}
  for (const route of routes) {
    if (route.pattern.includes("*")) continue
    const mod = await route.load()
    if (route.pattern.includes(":")) {
      if (mod.getStaticPaths === undefined) continue
      const { paths: staticPaths, fallback = "ssr" } = await mod.getStaticPaths()
      fallbacks[route.pattern] = fallback
      for (const { params } of staticPaths) {
        const { path, missing } = fillRoutePattern(route.pattern, params)
        if (missing.length === 0) paths.push(path)
      }
    } else if (mod.prerender === true) {
      paths.push(route.pattern)
    }
  }
  return { paths, fallbacks }
}

/** The prerendered-path subset of {@link enumerateStaticRoutes} — kept for callers that only need the
 * paths (e.g. injecting `window.__NIFRA_PRERENDERED__`). */
export async function enumeratePrerenderedPaths(routes: readonly RouteEntry[]): Promise<string[]> {
  return (await enumerateStaticRoutes(routes)).paths
}
