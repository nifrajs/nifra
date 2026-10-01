/**
 * Route manifest - the fs-free heart of file-based routing. Maps route file paths to nifra
 * router patterns + their nested layout chain. `discoverRoutes` (in `@nifrajs/web/fs`) scans
 * the filesystem and feeds `buildManifest`; everything here is pure logic, so it stays
 * portable (no fs, no DOM) and fully unit-testable. Edge deploys pre-build the manifest.
 */
import { routePatternOverlap } from "@nifrajs/core"
import { paramConstraint } from "@nifrajs/core/pattern"
import type { CookieOptions, ResponseResult, StandardSchemaV1 } from "@nifrajs/core/server"
import type { BoundaryDescriptor, BoundaryRegistration } from "./boundary.ts"

/**
 * Response controls a loader or action reaches as `ctx.set` - the page counterpart of a route
 * handler's `c.set`. Write before the loader or action returns; a write from a deferred promise that
 * settles later throws.
 */
export interface LoaderResponseControls {
  /**
   * Headers for the rendered document (`cache-control`, `x-robots-tag`, `link`, ...). A layout's
   * headers are applied first, then the page's, then the action's, so the most specific writer wins a
   * name. They are not applied to a redirect, a status page, an error page, or a navigation data
   * response. `content-type`, `set-cookie`, `location`, transport headers, and the `x-nifra-` prefix
   * are refused.
   */
  readonly headers: Record<string, string>
  /**
   * Queue a `Set-Cookie`, with the same secure defaults as `c.set.cookie`
   * (`HttpOnly; Secure; SameSite=Lax; Path=/`). The cookie rides every outcome - the document, a
   * navigation data response, a redirect, a status or error page - and makes the response
   * `cache-control: private, no-store`.
   */
  cookie(name: string, value: string, options?: CookieOptions): void
  /** Queue a cookie deletion. Match the `path`/`domain` the cookie was set with. */
  deleteCookie(name: string, options?: Pick<CookieOptions, "path" | "domain">): void
}

/** Context passed to a route `loader`. The `api` + `env` are injected by `createWebApp` and typed
 * per-route via `@nifrajs/client`'s `LoaderArgs<Api, Env>` (here they are opaque to the agnostic core). */
export interface LoaderContext {
  readonly params: Record<string, string>
  readonly request: Request
  /** Alias of {@link request} - mirrors a route handler's `c.req` so the same name works in both. */
  readonly req: Request
  readonly api: unknown
  /** Platform bindings forwarded from the request `c.env` (Workers env/KV/D1). Opaque here. */
  readonly env: unknown
  /** `true` when the request carries a valid draft/preview cookie (only when `createWebApp` is given a
   * `draftSecret`; otherwise always `false`). Branch on it to load unpublished content for editors. */
  readonly draft: boolean
  /** The URL search params, validated against the route's `searchSchema` (a Standard Schema) when it
   * declares one - failing closed to the schema's defaults - else the raw parsed query. Typed per-route
   * via `@nifrajs/client`'s `LoaderArgs<Api, Env, Search>`. */
  readonly search: Record<string, unknown>
  /** Response headers and cookies for this page request. */
  readonly set: LoaderResponseControls
}

/** A route's optional data loader: params/request in, data out. */
export type Loader = (ctx: LoaderContext) => unknown | Promise<unknown>

/**
 * The default export of a `_middleware.ts` file. It runs on the server before the layouts, loaders and
 * action of every route in its directory and below - on a document request, a client navigation and a
 * form post alike - and before a nested `_404` there. Middleware higher in the tree runs first.
 *
 * - Return nothing to let the request through.
 * - Return or throw a `redirect()`, a status such as `notFound()`, or a `Response` to answer with it:
 *   nothing below the middleware runs.
 * - `ctx.set` adds headers and cookies as a loader's does. A layout's or the page's header of the same
 *   name wins.
 * - `ctx.params` holds the params of the directory's own URL prefix, as a layout's loader sees them.
 *
 * It does not run for a prerendered page, an ISR cache hit, a mounted API or a static file. For
 * middleware on every request, export `use` from `framework.ts`. Pass a typed context to type
 * `ctx.api` and `ctx.env`: `RouteMiddleware<LoaderArgs<typeof app, Env>>`.
 */
export type RouteMiddleware<Ctx = LoaderContext> = (
  ctx: Ctx,
) => MiddlewareOutcome | Promise<MiddlewareOutcome>

/** What a {@link RouteMiddleware} answers with: nothing, to let the request through, or a response. */
export type MiddlewareOutcome = undefined | Response | ResponseResult

/** One client navigation, as a layout's {@link ShouldRevalidate} sees it. */
export interface ShouldRevalidateArgs {
  /** The URL the client is leaving. */
  readonly currentUrl: URL
  /** The URL being loaded. */
  readonly nextUrl: URL
  /** Every route param of the page being left - not only the ones the layout owns. */
  readonly currentParams: Readonly<Record<string, string>>
  /** Every route param of the page being loaded. */
  readonly nextParams: Readonly<Record<string, string>>
  /** The answer without the hook: `true` when a param the layout owns or the query changed. */
  readonly defaultShouldRevalidate: boolean
}

/**
 * A layout's say over whether its loader runs again on a client navigation. Export it from a
 * `_layout` next to the loader: `export const shouldRevalidate: ShouldRevalidate = (args) => ...`.
 *
 * - Asked on the server, on a client navigation that keeps this layout on screen, when the browser
 *   already holds its data. A document request, the revalidation after an action, and
 *   `router.invalidate()` always run the loader.
 * - Return `false` to keep the data the browser has; any other value runs the loader. Return
 *   `args.defaultShouldRevalidate` to keep the default for the cases you do not handle.
 * - Must be synchronous: a returned promise is not `false`, so the loader runs.
 * - Never asked for a `gate` layout, which runs on every request.
 * - A page's loader runs on every navigation and a page's `shouldRevalidate` is not read. Query keys
 *   a page's loader never uses belong in its `searchClientKeys`.
 */
export type ShouldRevalidate = (args: ShouldRevalidateArgs) => boolean

/**
 * A route's optional mutation, run on POST. Shares the loader context (params/request/api);
 * read the form/JSON body off `request`. Returns either a control-flow value (a `redirect()`, a
 * `status(...)` render, or a hand-rolled `Response` - all passed straight through) or data,
 * surfaced to the page component as `actionData`.
 */
export type Action = (ctx: LoaderContext) => unknown | Promise<unknown>

/** The body a client action may prepare for the server action. The server must validate it again. */
export type ClientRequestBody = NonNullable<RequestInit["body"]>

/** Safe, client-visible context for a client loader. It intentionally exposes no Request or headers. */
export interface ClientLoaderArgs {
  readonly url: string
  readonly params: Readonly<Record<string, string>>
  readonly signal: AbortSignal
  /** Lazily obtains the server loader result; repeated calls share one per-navigation request. */
  readonly serverLoader: () => Promise<unknown>
}

/** A client-only post-hydration data loader. Its return value replaces the route's rendered data. */
export type ClientLoader = (args: ClientLoaderArgs) => unknown | Promise<unknown>

/** Safe, client-visible context for a client action. No secrets or raw request headers cross this seam. */
export interface ClientActionArgs extends ClientLoaderArgs {
  readonly body: ClientRequestBody
}

/** Client action preparation. `body` is sent as untrusted input; `optimisticData` is never sent. */
export interface ClientActionResult {
  readonly body?: ClientRequestBody
  readonly optimisticData?: unknown
}

/** A client-only action wrapper; it never replaces the server action. */
export type ClientAction = (
  args: ClientActionArgs,
) => ClientActionResult | undefined | Promise<ClientActionResult | undefined>

/** Client hooks populated by the generated route entry after a route chunk loads. */
export interface ClientRouteHooks {
  readonly clientLoader?: ClientLoader
  readonly clientAction?: ClientAction
  /** Neutral boundary descriptors needed for soft-navigation interception. A boundary's loader lives in
   * the route's backend half, so the browser never learns whether one exists. */
  readonly boundaries?: ReadonlyArray<Omit<BoundaryDescriptor, "hasLoad">>
}

/**
 * One `<link>` tag's attributes for a route/layout's `meta.link`. The common HTML `<link>` attributes
 * are spelled out and **optional** so a typed partial like `{ rel, href, hreflang }` is assignable -
 * the previous `Record<string, string>` required *every* value to be a present string, which rejected
 * exactly that idiomatic shape (the bug this fixes). Standard attributes are explicit and the template
 * index signature admits inert `data-*` metadata without opening executable `on*` attributes. `boolean`
 * covers `disabled` (rendered bare when `true`, omitted when `false`), and `undefined` lets a caller
 * spread in a conditionally absent attribute. SSR and soft navigation apply one runtime allowlist too,
 * so a cast or untyped route cannot widen the injection surface.
 */
export interface LinkDescriptor {
  readonly rel?: string
  readonly href?: string
  readonly hreflang?: string
  readonly crossorigin?: string
  readonly media?: string
  readonly nonce?: string
  readonly sizes?: string
  readonly type?: string
  readonly as?: string
  readonly integrity?: string
  readonly referrerpolicy?: string
  readonly fetchpriority?: string
  readonly title?: string
  readonly imagesrcset?: string
  readonly imagesizes?: string
  readonly color?: string
  readonly disabled?: boolean
  readonly [attr: `data-${string}`]: string | undefined
}

/** One managed `<meta>` tag. Standard attributes and inert `data-*` metadata only. */
export interface MetaDescriptor {
  readonly charset?: string
  readonly content?: string
  readonly "http-equiv"?: string
  readonly itemprop?: string
  readonly media?: string
  readonly name?: string
  readonly property?: string
  readonly scheme?: string
  readonly [attr: `data-${string}`]: string | undefined
}

/** One `<script>` element a route contributes to `<head>` - for structured data (JSON-LD) and other
 * inert, non-executable head scripts. The `content` is the script body; `type` defaults to
 * `"application/ld+json"` (the common case). The renderer escapes `content` against an HTML breakout
 * (`</`, `<!--`, `]]>`) - see `escapeScriptContent` - so a JSON-LD payload can never close the
 * `<script>` element early. `content` is **JSON/text, never raw HTML**: this slot is not an XSS escape
 * hatch for arbitrary markup. */
export type InertScriptType = "application/ld+json" | "application/json"

export interface ScriptDescriptor {
  /** The script's `type` attribute. Default `"application/ld+json"`. */
  readonly type?: InertScriptType
  /** The script body (e.g. a `JSON.stringify`'d JSON-LD object). Escaped for safe `<script>` embedding. */
  readonly content: string
}

/** Explicit escape hatch for executable inline code. A CSP nonce is mandatory. */
export interface UnsafeScriptDescriptor {
  readonly unsafe: true
  readonly type: "module" | "text/javascript"
  readonly nonce: string
  readonly content: string
}

/**
 * The document head a route contributes - title + `<meta>`/`<link>`/`<script>` tag sets. Returned by a
 * route/layout `meta` (statically, or from a {@link MetaArgs} function). Every value is serialized into
 * managed (`data-nifra`) head tags: tag-specific attribute allowlists reject event handlers and active
 * URL/refresh contexts, values are HTML-escaped at render, and `script[].content` is breakout-escaped -
 * so loader-derived strings (LLM-authored `og:*`, user content) are XSS-safe by construction.
 * Layout-chain heads merge with the page's via `mergeHeads` (arrays concat outermost→page; `title` is
 * nearest-wins). Build `og:*`/`twitter:*` with `openGraph(...)`, canonical with `canonical(...)`, and
 * JSON-LD with `jsonLd(...)` (all from `@nifrajs/web`) rather than hand-writing the records.
 */
export interface Meta {
  readonly title?: string
  readonly meta?: readonly MetaDescriptor[]
  readonly link?: readonly LinkDescriptor[]
  /** Inert head `<script>`s (JSON-LD structured data, etc.). See {@link ScriptDescriptor}. */
  readonly script?: readonly ScriptDescriptor[]
  /** Executable inline scripts. Prefer external modules; construct only with `unsafeInlineScript()`. */
  readonly unsafeScript?: readonly UnsafeScriptDescriptor[]
  /**
   * The document language - `<html lang="...">`. Nearest-wins like `title`, so a localized route can
   * override a layout's default. Defaults to `"en"` when no head in the chain sets it.
   *
   * This is the ONLY way to set it: the shell's `<html>` is framework-owned, so a multilingual app
   * otherwise serves every URL as `lang="en"` - which tells a screen reader to pronounce every locale
   * with an English voice, and suppresses the browser's translation offer.
   */
  readonly lang?: string
  /**
   * The document writing direction - `<html dir="...">`. Nearest-wins like `title`. Omitted from the
   * shell when unset, which is HTML's `ltr` default, so an LTR app's output is byte-identical.
   *
   * Required for Arabic/Hebrew/Urdu/Persian: without it the browser lays the page out left-to-right
   * and mis-orders trailing punctuation, so the text renders wrong rather than merely unstyled.
   */
  readonly dir?: "ltr" | "rtl" | "auto"
}

/**
 * Args for a route's `meta` function: the loader's `data` + the route `params` + the request `origin`.
 * `meta()` runs in BOTH SSR and client navigation, so it has **no `request`/`process.env`/server access** -
 * `origin` is the only server-resolved fact it gets (so you needn't thread `siteUrl` through loader data
 * for absolute `og:url`/`canonical`/`og:image` URLs). See {@link origin}.
 */
export interface MetaArgs<Data = unknown> {
  readonly data: Data
  readonly params: Record<string, string>
  /** The resolved document CSP nonce, when this render uses per-request nonce protection. */
  readonly nonce?: string
  /**
   * The site origin - scheme + host (+ port), e.g. `"https://news.example.com"`, **with no trailing
   * slash**. The single piece of server/env knowledge `meta()` otherwise can't see: it runs in BOTH
   * SSR and client navigation, so it has no `request`/`process.env`. The framework resolves it from the
   * request URL during SSR and from `location.origin` on client nav - and they match, so an absolute
   * `og:url`/`canonical`/`og:image` built from it never drifts between the server-rendered `<head>` and
   * a soft-nav. Use it for absolute URLs (`origin + "/posts/" + slug`) instead of threading `siteUrl`
   * through loader data. Empty string (`""`) when the origin is unknown (e.g. a hand-built test render
   * with no request URL). A `meta()` that ignores `origin` is unchanged.
   */
  readonly origin: string
}

/** A route's `meta`: a static {@link Meta}, or a function of the loader data + params + the request
 * origin ({@link MetaArgs}). Use the `origin` arg for absolute `canonical`/`og:url`/`og:image` URLs -
 * it's resolved server-side from the request and matches the client's `location.origin`. */
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
   * (the natural hybrid behavior - an unlisted path simply isn't a static file); `"404"` → only the
   * listed paths exist. Recorded by `prerenderRoutes` for the deploy layer.
   */
  readonly fallback?: "ssr" | "404"
}

/** A dynamic route's build-time param enumeration (the SSG equivalent of "which pages exist"). */
export type GetStaticPaths = () => StaticPaths | Promise<StaticPaths>

/** A route module - the default component + optional loader / action / meta. */
export interface RouteModule {
  readonly default: unknown
  readonly loader?: Loader
  readonly action?: Action
  /** Optional client-only loader. It runs after hydration and on client navigations. */
  readonly clientLoader?: ClientLoader
  /** Optional client-only submit wrapper. The server action remains mandatory for mutations. */
  readonly clientAction?: ClientAction
  /** Named async boundaries owned by this route. The adapter renders their neutral state seam. A
   * boundary's `load` comes from {@link boundaryLoaders} in the route's backend half; the frontend
   * file declares only how it renders. */
  readonly boundaries?: readonly BoundaryRegistration[]
  /** Backend half only: each boundary's server loader, keyed by boundary name. */
  readonly boundaryLoaders?: Readonly<Record<string, BoundaryLoaderEntry>>
  /** A Standard Schema validating this route's URL search params. When present, `ctx.search` is parsed +
   * validated against it (failing closed to the schema's defaults on invalid input); type it into the
   * loader with `LoaderArgs<Api, Env, typeof searchSchema>`. */
  readonly searchSchema?: StandardSchemaV1<unknown, Record<string, unknown>>
  /** Search keys that are purely client-side UI (`"tab"`, a client-side `"sort"`, `"modal"`) and do NOT
   * affect this route's loader. When a client navigation stays on the same route + pathname and changes
   * ONLY these keys, the router updates the URL (so `useSearch` re-renders) WITHOUT re-running the loader.
   * Any other key change revalidates as usual - so omitting a data-affecting key here can never serve
   * stale data, it only forgoes the optimization. Client-only: the server always renders fresh. */
  readonly searchClientKeys?: readonly string[]
  readonly meta?: MetaInput
  /**
   * Opt this route out of nifra's full-document client hydration. The server still renders the full
   * HTML document, loaders/actions still run, and native links/forms still work; the generated app
   * client, route chunks, and loader globals are omitted for hard navigations. Intended for static or
   * island-hydrated pages where interactivity is mounted by smaller, explicit client entries.
   */
  readonly hydrate?: boolean
  /**
   * `false` renders this route's component in the browser only. The server still matches the route,
   * runs its gates and loaders, renders the layouts around it and embeds the data - it skips the
   * component alone, putting {@link HydrateFallback} (or nothing) in the page slot. The browser
   * hydrates against that, then renders the component. For a component that cannot render on a
   * server: one that reads `window` or a browser-only API while it renders.
   *
   * The module itself is still imported on the server, for its loader and options - so an import
   * that needs a browser at load time belongs inside the component (a dynamic `import()`), not at the
   * top of the file. Cannot be combined with `hydrate = false`: nothing would ever render the page.
   */
  readonly ssr?: boolean
  /**
   * What the server renders in the page slot of an `ssr = false` route, and what the browser hydrates
   * before the component takes over - a skeleton, a spinner. Receives the same props as the
   * component, loader `data` included. Omitted ⇒ the slot is empty until the component renders.
   */
  readonly HydrateFallback?: unknown
  /**
   * Any value to report through `useMatches` - a breadcrumb label, a render function, a flag a layout
   * reads about the page inside it. Layouts, pages, and status pages may export one. It is read from
   * the module on the server and in the browser, so it must be the same value on both.
   */
  readonly handle?: unknown
  /**
   * Opt a **static** route (no `:param`/`*`) into build-time prerendering (SSG): `prerenderRoutes`
   * (from `@nifrajs/web/build`) renders it to a static `index.html` at build. The loader runs at build
   * with the in-process `api` (build-safe data only - no per-request cookies/secrets); `defer()` on a
   * prerendered route resolves at build. For **dynamic** routes use {@link getStaticPaths} instead.
   */
  readonly prerender?: boolean
  /**
   * Enumerate the concrete params to prerender for a **dynamic** (`:param`) route - the SSG path list
   * (blogs/docs/etc.). Runs at build; `prerenderRoutes` renders one `index.html` per returned path.
   */
  readonly getStaticPaths?: GetStaticPaths
  /**
   * ISR freshness for this route, in **seconds**. `createWebApp` emits it as an
   * `x-nifra-isr-revalidate` response header that `withISR` reads to set the page's cache TTL
   * (overriding the wrapper's default). Older-than-`revalidate` cached pages are served stale while
   * regenerating. (Distinct from the action-revalidation `x-nifra-revalidate` header - a CSV path
   * list the client parses to refetch - so the two channels never alias.)
   */
  readonly revalidate?: number
  /** Optional bounded tags used by ISR on-demand invalidation (`?tag=...`). */
  readonly revalidateTags?: readonly string[]
  /**
   * No-framework island bundles (`@nifrajs/web/islands`) to load on this route, as `<script
   * type="module">` in the document tail. Loaded **regardless of `hydrate`** - pair with
   * `export const hydrate = false` for a static page that ships zero framework JS and mounts
   * interactivity through `<Island>` markers + `mountIslands` enhancers instead.
   */
  readonly islandScripts?: readonly string[]
}

/** A boundary's server loader, declared in the route's backend half under `boundaryLoaders`. */
export interface BoundaryLoaderEntry {
  readonly load: NonNullable<BoundaryRegistration["load"]>
}

/** A layout (or `_404`/`_error`) entry: its source file (for client codegen) + a lazy loader.
 *
 * A `_layout.tsx` may export `meta` (static {@link Meta} or a function of the loader data + params,
 * same shape as a route's) to contribute sitewide `<head>` tags - `hreflang`/`preconnect`/etc. that
 * belong on every page under the layout. The layout chain's heads merge with the page's: arrays
 * (`meta`/`link`) concatenate outermost→innermost→page; scalars (`title`) are nearest-wins (the page
 * overrides an inner layout, which overrides an outer one). See `mergeHeads` in `@nifrajs/web`. */
export interface LayoutEntry {
  /** The frontend half: the file the browser bundle imports. */
  readonly file: string
  /** The backend half (`x.backend.ts`), when the file has one. Server-only: never in a client bundle. */
  readonly backend?: string
  /** Both halves, merged and checked. */
  readonly load: () => Promise<RouteModule>
}

/** One matched route: pattern, nested layout ids (outermost → innermost), source file, loader. */
export interface RouteEntry {
  readonly id: string
  readonly pattern: string
  readonly layoutIds: readonly string[]
  /**
   * Param names each layout in {@link layoutIds} owns, aligned by index.
   *
   * A layout wraps a URL prefix, so these are the params it may read and the ones whose change should
   * re-run its loader - everything deeper belongs to routes beneath it. Derived per (route, layout)
   * pair rather than per layout, because one layout can own different params on different expanded
   * patterns: `[[lang]]/docs/_layout` owns nothing on `/docs/:slug` and `{lang}` on `/:lang/docs/:slug`.
   * Optional only so hand-built test manifests may omit it.
   */
  readonly layoutParams?: ReadonlyArray<readonly string[]>
  /** `_middleware` ids in this route's ancestor chain (outermost → innermost), run before its
   * layouts. Absent ⇒ none. */
  readonly middlewareIds?: readonly string[]
  /** Param names each middleware in {@link middlewareIds} sees, aligned by index: the params of its
   * directory's URL prefix, as {@link layoutParams} holds them for a layout. */
  readonly middlewareParams?: ReadonlyArray<readonly string[]>
  /** `_error` boundary ids in this route's ancestor chain (outermost → innermost). The last is the
   * **nearest** boundary, rendered when the route's loader throws. Always set by `buildManifest`
   * (optional only so hand-built test manifests may omit it); absent/empty ⇒ no boundary (error 500s). */
  readonly errorIds?: readonly string[]
  /** Nested `_404` page ids in this route's ancestor chain (outermost → innermost); the root `_404`
   * is not listed. The last is the **nearest**, rendered when the route's loader answers
   * `notFound()`. Absent ⇒ the root `_404`. */
  readonly notFoundIds?: readonly string[]
  /** `_loading` page ids in this route's ancestor chain (outermost → innermost). A client navigation
   * to the route shows the innermost one whose layouts are already on screen. Absent ⇒ none. */
  readonly loadingIds?: readonly string[]
  /** The frontend half: the file the browser bundle imports. */
  readonly file: string
  /** The backend half (`x.backend.ts`), when the route has one. Server-only. */
  readonly backend?: string
  /** Both halves, merged and checked. */
  readonly load: () => Promise<RouteModule>
}

/** One URL pattern a nested `_404` answers when no route matches it. */
export interface NotFoundScope {
  /** The directory's URL prefix (`/admin`) or everything beneath it (`/admin/*`). */
  readonly pattern: string
  /** Param names each layout in {@link NotFoundEntry.layoutIds} owns on this pattern, by index. */
  readonly layoutParams: ReadonlyArray<readonly string[]>
  /** Param names each middleware in {@link NotFoundEntry.middlewareIds} sees on this pattern, by
   * index. Absent when the page has no middleware. */
  readonly middlewareParams?: ReadonlyArray<readonly string[]>
}

/** A `_404` page below the routes root. */
export interface NotFoundEntry extends LayoutEntry {
  /** Layouts at or above the page's directory (outermost → innermost) - the ones it renders inside. */
  readonly layoutIds: readonly string[]
  /** `_error` boundaries at or above the page's directory (outermost → innermost). */
  readonly errorIds: readonly string[]
  /** `_middleware` ids at or above the page's directory (outermost → innermost). Absent ⇒ none. */
  readonly middlewareIds?: readonly string[]
  /**
   * The URL patterns this page answers when no route matches. Empty when the directory is a
   * catch-all, or when a `_404` in a directory above it answers the same URLs - the page is then
   * reached only by `notFound()` from a route beneath it.
   */
  readonly scopes: readonly NotFoundScope[]
}

/** A `_loading` page: what the page slot shows while a client navigation loads. */
export interface LoadingEntry extends LayoutEntry {
  /** Layouts at or above the page's directory (outermost → innermost). The page shows only while
   * every one of them is on screen, so it never renders outside a layout above it. */
  readonly layoutIds: readonly string[]
}

/** The full route manifest. */
export interface Manifest {
  readonly routes: readonly RouteEntry[]
  readonly layouts: Readonly<Record<string, LayoutEntry>>
  /** Per-segment `_error` boundary components, keyed by id (`_error`, `a/_error`, …). Always set by
   * `buildManifest` (optional only so hand-built test manifests may omit it). */
  readonly errors?: Readonly<Record<string, LayoutEntry>>
  /** The `_404` at the routes root: unmatched URLs and `notFound()` wherever no nested one applies. */
  readonly notFound?: LayoutEntry
  /**
   * `_404` pages below the routes root, keyed by id (`admin/_404`, …). Each answers `notFound()` from
   * the routes beneath its directory and the unmatched URLs under that directory's URL prefix, and
   * renders inside the layouts at or above it. Absent when the app has none.
   */
  readonly notFounds?: Readonly<Record<string, NotFoundEntry>>
  /** Per-status terminal pages from `_<status>.tsx` at the routes root (`_410`, `_451`, …), keyed by
   * the status as a string. Rendered by a loader's `gone()` / `statusPage(n)`; a status with no page
   * falls back to `_404`, and then to plain text. `_404` itself stays on {@link notFound} - it is
   * reached by unmatched paths too, which these are not. */
  readonly statusPages?: Readonly<Record<string, LayoutEntry>>
  /**
   * `_loading` pages, keyed by id (`_loading`, `admin/_loading`, …). A client navigation that is
   * still loading after a short delay shows the target route's nearest one in the page slot, inside
   * the layouts the two pages share. Browser-only: the server never renders one. Absent when the app
   * has none.
   */
  readonly loadings?: Readonly<Record<string, LoadingEntry>>
  /**
   * Middleware candidates, keyed by id (`_middleware`, `admin/_middleware`, …): one per directory
   * with a `_layout.backend.ts`, whose `middleware` export each loads as `default` (`undefined` when
   * that file exports none). Server-only: the client build never imports one. Absent when no
   * directory has a layout backend half.
   */
  readonly middlewares?: Readonly<Record<string, LayoutEntry>>
}

// `.svelte` and `.vue` routes are supported too: their `default` export is the component and
// `loader`/`action`/`meta` come from a module-level script block (Svelte `<script module>`, Vue's plain
// `<script>`) as named ESM exports - the same RouteModule shape as `.tsx`. Both compile via their
// package's Bun plugin (`@nifrajs/web-svelte/plugin`, `@nifrajs/web-vue/plugin`).
const ROUTE_EXT = /\.(tsx|jsx|svelte|vue|mdx)$/
const PARAM = /^\[([A-Za-z_][A-Za-z0-9_]*)\]$/
const CATCH_ALL = /^\[\.\.\.([A-Za-z_][A-Za-z0-9_]*)\]$/
// An optional dynamic segment: `[[lang]]` matches with OR without the segment. It expands a file into
// two patterns (`:lang` present / absent), so `[[lang]]/about` serves both `/about` and `/en/about`.
const OPTIONAL = /^\[\[([A-Za-z_][A-Za-z0-9_]*)\]\]$/
// A route group: a `(name)` folder organizes routes (and can hold its own `_layout`) without
// contributing a URL segment - mirrors Next/Remix. Requires content between the parens.
const GROUP = /^\(.+\)$/
// A terminal status page: `_410.tsx`, `_451.tsx`. `_404` is matched before this and stays its own
// thing. Restricted to 3 digits so `_401k` or `_4` is treated as an ordinary underscore-prefixed
// file (ignored) rather than silently becoming a status page.
const STATUS_PAGE = /^_[1-5][0-9][0-9]$/
// The retired `_middleware.ts`. Discovery still collects it, so that it fails loudly rather than
// silently stopping guarding anything.
const MIDDLEWARE_FILE = /^_middleware\.(?:ts|js)$/
// A route's backend half: `x.backend.ts` beside `x.tsx`. Script extensions only - JSX renders, and
// rendering belongs to the frontend half.
const ROUTE_BACKEND = /\.backend\.(?:[cm]?[jt]s)$/
// A zone or retired suffix on a route file (`x.backend.tsx`) would otherwise become a URL segment.
const SUFFIXED_ROUTE = /\.(?:backend|frontend|shared|fn|server)$/

const stripExt = (file: string): string => file.replace(ROUTE_EXT, "")
const baseName = (file: string): string => file.slice(file.lastIndexOf("/") + 1)

/** Whether a routes-relative path is a retired `_middleware` module. Discovery collects it only so
 * that {@link buildManifest} can refuse it with the migration. */
export const isMiddlewareFile = (file: string): boolean => MIDDLEWARE_FILE.test(baseName(file))

/** Whether a routes-relative path is a route's backend half (`x.backend.ts`). */
export const isRouteBackendFile = (file: string): boolean => ROUTE_BACKEND.test(baseName(file))

/** The backend half a frontend route file pairs with: `blog/[slug].tsx` -> `blog/[slug].backend.ts`. */
export const backendFileFor = (file: string): string => `${stripExt(file)}.backend.ts`

/** Exports the browser runs or reads. They live in a route's frontend file, which ships whole. */
export const FRONTEND_ROUTE_EXPORTS: ReadonlySet<string> = new Set([
  "default",
  "meta",
  "handle",
  "HydrateFallback",
  "searchSchema",
  "searchClientKeys",
  "clientLoader",
  "clientAction",
  "boundaries",
  "ssr",
])

/** Exports only the server or the build reads. They live in the route's `x.backend.ts`. */
export const BACKEND_ROUTE_EXPORTS: ReadonlySet<string> = new Set([
  "loader",
  "action",
  "loaderOutput",
  "actionOutput",
  "boundaryLoaders",
  "getStaticPaths",
  "prerender",
  "revalidate",
  "revalidateTags",
  "hydrate",
  "islandScripts",
  "middleware",
])

const routeError = (message: string): Error => new Error(`[nifra/web] ${message}`)

/** The frontend export names a backend-only name was found under, for the move-it message. */
function assertFrontendHalf(file: string, front: Readonly<Record<string, unknown>>): void {
  for (const name of Object.keys(front)) {
    if (BACKEND_ROUTE_EXPORTS.has(name)) {
      throw routeError(
        `"${file}" exports "${name}", which runs on the server only. Move it to "${backendFileFor(file)}": a route's frontend file ships to the browser whole`,
      )
    }
  }
  const boundaries = front.boundaries
  if (Array.isArray(boundaries)) {
    for (const boundary of boundaries as ReadonlyArray<{ name?: unknown; load?: unknown }>) {
      if (boundary?.load !== undefined) {
        throw routeError(
          `boundary "${String(boundary.name)}" in "${file}" declares its load function in the frontend file. Move it to boundaryLoaders["${String(boundary.name)}"].load in "${backendFileFor(file)}"`,
        )
      }
    }
  }
}

function assertBackendHalf(
  file: string,
  backend: string,
  back: Readonly<Record<string, unknown>>,
  allowMiddleware: boolean,
): void {
  for (const name of Object.keys(back)) {
    if (name === "middleware" && !allowMiddleware) {
      throw routeError(
        `"${backend}" exports "middleware", which only a directory's _layout.backend.ts may export`,
      )
    }
    if (BACKEND_ROUTE_EXPORTS.has(name)) continue
    throw routeError(
      FRONTEND_ROUTE_EXPORTS.has(name)
        ? `"${backend}" exports "${name}", which the browser needs. Move it to "${file}"`
        : `"${backend}" exports "${name}", which nifra does not read from a backend half. It may export only: ${[...BACKEND_ROUTE_EXPORTS].join(", ")}`,
    )
  }
}

// One merged module per (frontend namespace, backend namespace) pair. A runtime caches each module,
// so a page served many times merges once; a dev re-import yields new namespaces and a fresh merge.
const mergedHalves = new WeakMap<
  object,
  { readonly back: object | undefined; readonly module: RouteModule }
>()

/**
 * Merge a route's two halves into the one {@link RouteModule} the server runs, refusing any export on
 * the wrong side. The checks run on every server, dev and production alike, so a misplaced `loader`
 * fails the first request to its route even before a client build has looked at it.
 */
export function mergeRouteHalves(
  file: string,
  front: RouteModule,
  backend: string | undefined,
  back: Readonly<Record<string, unknown>> | undefined,
): RouteModule {
  const cached = mergedHalves.get(front)
  if (cached !== undefined && cached.back === back) return cached.module
  assertFrontendHalf(file, front as unknown as Readonly<Record<string, unknown>>)
  if (back === undefined || backend === undefined) {
    mergedHalves.set(front, { back, module: front })
    return front
  }
  assertBackendHalf(file, backend, back, stripExt(baseName(file)) === "_layout")
  const { middleware: _middleware, boundaryLoaders, ...server } = back
  let boundaries = front.boundaries
  if (boundaryLoaders !== undefined) {
    if (typeof boundaryLoaders !== "object" || boundaryLoaders === null) {
      throw routeError(`"${backend}" exports boundaryLoaders that is not an object of loaders`)
    }
    const loaders = boundaryLoaders as Readonly<Record<string, { readonly load?: unknown }>>
    const declared = new Set((front.boundaries ?? []).map((boundary) => boundary.name))
    for (const [name, entry] of Object.entries(loaders)) {
      if (!declared.has(name)) {
        throw routeError(
          `"${backend}" has boundaryLoaders["${name}"], but "${file}" declares no boundary named "${name}"`,
        )
      }
      if (typeof entry?.load !== "function") {
        throw routeError(`boundaryLoaders["${name}"].load in "${backend}" must be a function`)
      }
    }
    boundaries = front.boundaries?.map((boundary) => {
      const entry = loaders[boundary.name]
      return entry === undefined
        ? boundary
        : ({ ...boundary, load: entry.load } as BoundaryRegistration)
    })
  }
  const module = {
    ...front,
    ...server,
    ...(boundaries === undefined ? {} : { boundaries }),
  } as RouteModule
  mergedHalves.set(front, { back, module })
  return module
}
const dirOf = (file: string): string =>
  file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ""
const layoutIdFor = (dir: string): string => (dir === "" ? "_layout" : `${dir}/_layout`)
const errorIdFor = (dir: string): string => (dir === "" ? "_error" : `${dir}/_error`)
const notFoundIdFor = (dir: string): string => `${dir}/_404`
const loadingIdFor = (dir: string): string => (dir === "" ? "_loading" : `${dir}/_loading`)
const middlewareIdFor = (dir: string): string => (dir === "" ? "_middleware" : `${dir}/_middleware`)
const isDirAtOrAbove = (dir: string, other: string): boolean =>
  dir === "" || dir === other || other.startsWith(`${dir}/`)

/**
 * Derive **every** nifra router pattern a route file maps to (relative to the routes dir):
 * `index` → the parent path, `[id]` → `:id`, `[...slug]` → `*slug` (catch-all, captures the rest of
 * the path into one param), `(group)` folders are dropped from the URL (organization only), and an
 * optional `[[lang]]` expands the set - once with the segment present (`:lang`) and once absent. A file
 * with no optionals yields exactly one pattern. Throws on an invalid param or a catch-all that isn't
 * the last segment.
 */
/** Every `[…]` marker in a file segment, so a part-literal segment can be spliced into a pattern. */
// `[` is excluded from the inner class as well as `]`: marker names are identifiers, and letting the
// class swallow `[` makes a run of unclosed brackets backtrack quadratically (each start position
// re-scans the rest of the segment before failing).
const FILE_MARKER = /\[([^\][]*)\]/g
const FILE_PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Translate a part-literal-part-`[param]` file segment into its route pattern, or `undefined` when
 * the segment is wholly literal or wholly a marker (both already handled by the caller).
 *
 * `[inKey].txt` becomes `:inKey.txt`. Needed because IndexNow-style verification files, per-locale
 * sitemaps, and static-site URL parity (`post-[id].html`) all put a variable INSIDE a filename, and
 * `stripExt` already reduces `[inKey].txt.tsx` to `[inKey].txt` - `robots.txt.tsx` proves literal
 * dots survive into a segment, so this was only ever a parser gap.
 *
 * A `{...}` group straight after a marker that the router would read as a param constraint
 * (`[id]{a|b}`) is rejected too: see the check below.
 *
 * `[[optional]]` and `[...catchAll]` are **rejected** inside a mixed segment rather than given a
 * meaning. There is no sensible absent form for `/[[locale]]-feed.xml` - `/-feed.xml` and dropping
 * the segment are both surprising - and a catch-all captures the remaining path verbatim, which
 * conflicts with a trailing literal. A clear rejection beats semantics nobody can predict.
 */
function mixedFileSegment(seg: string, file: string): string | undefined {
  // A segment that is ENTIRELY one of the existing whole-segment forms belongs to the caller, not
  // here. Checked against the real patterns rather than by comparing the first marker to the
  // segment: `[[lang]]` does not equal its own first `[…]` match, so a naive comparison sends every
  // optional segment down the mixed path and rejects it.
  if (PARAM.test(seg) || OPTIONAL.test(seg) || CATCH_ALL.test(seg)) return undefined
  const markers = [...seg.matchAll(FILE_MARKER)]
  if (markers.length === 0) return undefined

  let pattern = ""
  let cursor = 0
  for (const marker of markers) {
    const inner = marker[1] ?? ""
    if (inner.startsWith("...")) {
      throw new Error(
        `[nifra/web] catch-all "[${inner}]" cannot be combined with literal text in "${file}" (segment "${seg}") - a catch-all captures the rest of the path, so a trailing literal can never match. Give it its own segment.`,
      )
    }
    if (inner.startsWith("[")) {
      throw new Error(
        `[nifra/web] optional "[${inner}]]" cannot be combined with literal text in "${file}" (segment "${seg}") - there is no sensible form for the segment when it is absent. Use a required [name], or give the optional its own segment.`,
      )
    }
    if (!FILE_PARAM_NAME.test(inner)) {
      throw new Error(
        `[nifra/web] invalid route param in "${file}": "[${inner}]" must be [name], [[name]], [...name], or a (group) folder`,
      )
    }
    pattern += `${seg.slice(cursor, marker.index)}:${inner}`
    cursor = (marker.index ?? 0) + marker[0].length
    // The router reads `:name{...}` as a constraint on the param. A file name is not the place for
    // one: links, prerendered paths and hydration all rebuild a URL from the pattern by name.
    if (paramConstraint(seg.slice(cursor)) !== undefined) {
      throw new Error(
        `[nifra/web] a param constraint cannot be written in a route file name: "${file}" (segment "${seg}"). Check the value in the route's loader instead, or rename the file so "[${inner}]" is not followed by a "{...}" group.`,
      )
    }
  }
  return pattern + seg.slice(cursor)
}

export function filePathToPatterns(file: string): string[] {
  return filePathToRoutes(file).map((route) => route.pattern)
}

/** One URL pattern a route file expands to, plus the scope information layouts need. */
export interface FileRoutePattern {
  readonly pattern: string
  /**
   * URL segments contributed by the first *k* path parts of the file, indexed by *k*.
   *
   * This is what makes a layout's scope derivable without turning layouts into router nodes. A layout
   * lives at a directory; the segments that directory contributes are exactly the prefix of the URL it
   * wraps, so `depths[partsIn(layoutDir)]` is how many leading pattern segments it owns - and the
   * params inside that prefix are the ones it may read.
   *
   * Per EXPANDED pattern, not per file, because the two diverge: `[[lang]]/docs/_layout` owns nothing
   * on `/docs/:slug` and `{lang}` on `/:lang/docs/:slug`. A route group contributes no segment, so
   * `(marketing)/_layout` owns nothing at all.
   */
  readonly depths: readonly number[]
}

/** Expand a route file into its URL patterns, each carrying per-directory segment counts. */
export function filePathToRoutes(file: string): FileRoutePattern[] {
  // Each combo is the URL segments built so far, plus the running per-path-part segment count.
  let combos: Array<{ segs: string[]; depths: number[] }> = [{ segs: [], depths: [0] }]
  const segments = stripExt(file).split("/")
  // Record the running segment count after each path part, on every combo. Called once per part so
  // `depths` stays index-aligned with the file's path parts even for parts that emit nothing.
  const mark = (): void => {
    for (const combo of combos) combo.depths.push(combo.segs.length)
  }
  const push = (segment: string): void => {
    for (const combo of combos) combo.segs.push(segment)
  }
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!
    if (seg === "index") {
      mark()
      continue
    }
    if (GROUP.test(seg)) {
      // Route group - no URL segment (its `_layout` still applies, keyed by dir).
      mark()
      continue
    }
    // A segment that is part literal, part `[param]` - `[inKey].txt`, `post-[id].html`. Checked
    // before the whole-segment forms below, which only handle a marker spanning the entire segment.
    const mixed = mixedFileSegment(seg, file)
    if (mixed !== undefined) {
      push(mixed)
      mark()
      continue
    }
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
        push(`*${catchAll[1]}`)
        mark()
        continue
      }
      const optional = OPTIONAL.exec(seg)
      if (optional !== null) {
        // Optional segment: keep each existing combo (absent) AND a copy with `:name` appended (present).
        combos = combos.flatMap((c) => [
          { segs: c.segs, depths: c.depths },
          { segs: [...c.segs, `:${optional[1]}`], depths: [...c.depths] },
        ])
        mark()
        continue
      }
      const match = PARAM.exec(seg)
      if (match === null) {
        throw new Error(
          `[nifra/web] invalid route param in "${file}": "${seg}" must be [name], [[name]], [...name], or a (group) folder`,
        )
      }
      push(`:${match[1]}`)
    } else {
      push(seg)
    }
    mark()
  }
  return combos.map((c) => ({ pattern: `/${c.segs.join("/")}`, depths: c.depths }))
}

/**
 * The **canonical** single pattern for a route file - all optional segments present. A file with no
 * optionals yields its one pattern. Use {@link filePathToPatterns} to get every pattern (optionals
 * expand the set).
 */
export function filePathToPattern(file: string): string {
  const patterns = filePathToPatterns(file)
  return patterns[patterns.length - 1]!
}

/** The dir chain from root → the file's own dir, e.g. "a/b/p.tsx" → ["", "a", "a/b"]. */
/**
 * Param names in the first `count` segments of a pattern - the params a layout at that depth owns.
 *
 * This is the whole scoping mechanism: a layout wraps a URL prefix, so the params inside that prefix
 * are the ones it may read, and the ones whose change should re-run its loader. Everything deeper
 * belongs to routes below it and must not invalidate it.
 */
function paramsInPrefix(pattern: string, count: number): string[] {
  if (count === 0) return []
  const names: string[] = []
  const segments = pattern === "/" ? [] : pattern.slice(1).split("/")
  for (const segment of segments.slice(0, count)) {
    // Mirrors the router's own grammar: `:name`, `*name`, and a mixed segment's embedded `:name`s.
    for (const match of segment.matchAll(/[:*]([A-Za-z_][A-Za-z0-9_]*)/g)) {
      names.push(match[1] as string)
    }
  }
  return names
}

/** The params each directory in `dirs` owns on one expanded pattern - see {@link paramsInPrefix}. */
const paramsOwnedBy = (
  dirs: readonly string[],
  pattern: string,
  depths: readonly number[],
): string[][] =>
  dirs.map((dir) => paramsInPrefix(pattern, depths[dir === "" ? 0 : dir.split("/").length] ?? 0))

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
 * turns a path into a lazy module loader. Pure - no fs. Throws at boot (the loud-and-early
 * RouteConfigError ethos) on duplicate patterns. `_layout`/`_404`/`_error`/`_loading`/`_middleware`
 * files are special; other `_`-prefixed files are ignored (private/colocated, never routed).
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
  const notFoundFiles = new Map<string, string>()
  const statusPages: Record<string, LayoutEntry> = {}
  const loadingFiles = new Map<string, string>()
  const middlewareFiles = new Map<string, string>()
  const routeFiles: string[] = []

  // Pair each frontend file with its `x.backend.ts`. A backend half is never a route of its own.
  const backendByStem = new Map<string, string>()
  const frontendFiles: string[] = []
  for (const file of files) {
    if (isMiddlewareFile(file)) {
      throw routeError(
        `"${file}" is retired: export \`middleware\` from "${dirOf(file) === "" ? "" : `${dirOf(file)}/`}_layout.backend.ts" instead (\`nifra migrate layout\` moves it)`,
      )
    }
    if (!isRouteBackendFile(file)) {
      frontendFiles.push(file)
      continue
    }
    const stem = file.replace(ROUTE_BACKEND, "")
    const other = backendByStem.get(stem)
    if (other !== undefined) {
      throw routeError(`two backend halves for one route: "${other}" and "${file}"; keep one`)
    }
    backendByStem.set(stem, file)
  }
  const pairedBackends = new Set<string>()
  const frontendStems = new Map<string, string>()
  const halves = (
    file: string,
  ): { readonly backend?: string; readonly load: () => Promise<RouteModule> } => {
    const backend = backendByStem.get(stripExt(file))
    const loadFront = importer(file)
    if (backend === undefined) {
      return {
        load: () =>
          loadFront().then((front) => mergeRouteHalves(file, front, undefined, undefined)),
      }
    }
    pairedBackends.add(backend)
    const loadBack = importer(backend)
    return {
      backend,
      load: () =>
        Promise.all([loadFront(), loadBack()]).then(([front, back]) =>
          mergeRouteHalves(
            file,
            front,
            backend,
            back as unknown as Readonly<Record<string, unknown>>,
          ),
        ),
    }
  }

  // Every `_layout.backend.ts` is a middleware candidate for its directory, with or without a
  // frontend layout beside it; one exporting no `middleware` resolves to `undefined` and is skipped.
  for (const [stem, backend] of backendByStem) {
    if (baseName(stem) !== "_layout") continue
    middlewareFiles.set(dirOf(backend), backend)
    pairedBackends.add(backend)
  }

  for (const file of frontendFiles) {
    const stem = stripExt(baseName(file))
    const twin = frontendStems.get(stripExt(file))
    if (twin !== undefined) {
      throw routeError(`two frontend files for one route: "${twin}" and "${file}"; keep one`)
    }
    frontendStems.set(stripExt(file), file)
    if (SUFFIXED_ROUTE.test(stem)) {
      throw routeError(
        `"${file}" is a route file with a zone suffix. A route's backend half is a script file ("${stem}.ts"), and other zoned code belongs outside routes/`,
      )
    }
    if (stem === "_middleware") {
      throw routeError(
        `"${file}" is retired: export \`middleware\` from "${dirOf(file) === "" ? "" : `${dirOf(file)}/`}_layout.backend.ts" instead (\`nifra migrate layout\` moves it)`,
      )
    }
    if (stem === "_layout") {
      const dir = dirOf(file)
      layoutDirs.add(dir)
      layouts[layoutIdFor(dir)] = { file, ...halves(file) }
    } else if (stem === "_error") {
      const dir = dirOf(file)
      errorDirs.add(dir)
      errors[errorIdFor(dir)] = { file, ...halves(file) }
    } else if (stem === "_404") {
      const dir = dirOf(file)
      notFoundFiles.set(dir, file)
      if (dir === "") notFound = { file, ...halves(file) }
    } else if (stem === "_loading") {
      loadingFiles.set(dirOf(file), file)
    } else if (STATUS_PAGE.test(stem) && dirOf(file) === "") {
      // `_410.tsx`, `_451.tsx`, … at the routes root. Root-only: unlike `_error`, these are not
      // resolved per segment - a terminal status is a property of the outcome, not of where in the
      // tree the route lives, and a per-segment variant would need a precedence rule nobody asked for.
      statusPages[stem.slice(1)] = { file, ...halves(file) }
    } else if (!stem.startsWith("_")) {
      routeFiles.push(file)
    }
  }

  const byPattern = new Map<string, string>()
  const routes: RouteEntry[] = []
  for (const file of routeFiles) {
    const dirs = ancestorDirs(file)
    const layoutDirsForFile = dirs.filter((dir) => layoutDirs.has(dir))
    const layoutIds = layoutDirsForFile.map(layoutIdFor)
    const errorIds = dirs.filter((dir) => errorDirs.has(dir)).map(errorIdFor)
    const notFoundIds = dirs
      .filter((dir) => dir !== "" && notFoundFiles.has(dir))
      .map(notFoundIdFor)
    const loadingIds = dirs.filter((dir) => loadingFiles.has(dir)).map(loadingIdFor)
    const middlewareDirsForFile = dirs.filter((dir) => middlewareFiles.has(dir))
    const middlewareIds = middlewareDirsForFile.map(middlewareIdFor)
    const id = stripExt(file)
    // One lazy loader per file, shared by its (possibly expanded) patterns.
    const { backend, load } = halves(file)
    // An optional `[[x]]` segment expands a file into multiple patterns, all pointing at the same
    // module (same id/load/layout chain). Distinct patterns ⇒ no match ambiguity (different lengths).
    for (const { pattern, depths } of filePathToRoutes(file)) {
      const existing = byPattern.get(pattern)
      if (existing !== undefined) {
        throw new Error(
          `[nifra/web] duplicate route: "${file}" and "${existing}" both map to "${pattern}"`,
        )
      }
      for (const previous of routes) {
        const witness = routePatternOverlap(previous.pattern, pattern)
        if (witness !== undefined) {
          throw new Error(
            `[nifra/web] overlapping routes: "${previous.file}" (${previous.pattern}) and "${file}" (${pattern}) both match "${witness}"; make the patterns disjoint or remove one route`,
          )
        }
      }
      byPattern.set(pattern, file)
      routes.push({
        id,
        pattern,
        layoutIds,
        layoutParams: paramsOwnedBy(layoutDirsForFile, pattern, depths),
        ...(middlewareIds.length > 0
          ? {
              middlewareIds,
              middlewareParams: paramsOwnedBy(middlewareDirsForFile, pattern, depths),
            }
          : {}),
        errorIds,
        ...(notFoundIds.length > 0 ? { notFoundIds } : {}),
        ...(loadingIds.length > 0 ? { loadingIds } : {}),
        file,
        ...(backend === undefined ? {} : { backend }),
        load,
      })
    }
  }

  // Nested `_404` pages. Each answers the unmatched URLs under its directory's URL prefix; when two
  // directories share a prefix (a route group adds no segment), the one that contains the others
  // answers, and with no such directory the choice would be arbitrary - so it is a boot error.
  const scopeOwners = new Map<string, string[]>()
  const scopesByDir = new Map<string, Array<NotFoundScope & { readonly shape: string }>>()
  for (const dir of notFoundFiles.keys()) {
    const layoutDirsForDir = ancestorDirs(`${dir}/_404`).filter((d) => layoutDirs.has(d))
    const middlewareDirsForDir = ancestorDirs(`${dir}/_404`).filter((d) => middlewareFiles.has(d))
    const scopes: Array<NotFoundScope & { readonly shape: string }> = []
    const forms =
      dir === "" ? [{ pattern: "/", depths: [0] }] : filePathToRoutes(`${dir}/index.tsx`)
    for (const { pattern: prefix, depths } of forms) {
      // A catch-all directory already matches everything beneath it: nothing there is unmatched.
      if (/(?:^|\/)\*[^/]*$/.test(prefix)) continue
      const layoutParams = paramsOwnedBy(layoutDirsForDir, prefix, depths)
      const middlewareParams =
        middlewareDirsForDir.length === 0
          ? undefined
          : paramsOwnedBy(middlewareDirsForDir, prefix, depths)
      for (const pattern of prefix === "/" ? ["/*"] : [prefix, `${prefix}/*`]) {
        // Two directories answer the same URLs when their patterns differ only in param names.
        const shape = pattern.replace(/([:*])[A-Za-z_][A-Za-z0-9_]*/g, "$1")
        if (scopes.some((scope) => scope.shape === shape)) continue
        scopes.push({
          pattern,
          layoutParams,
          ...(middlewareParams === undefined ? {} : { middlewareParams }),
          shape,
        })
        const owners = scopeOwners.get(shape)
        if (owners === undefined) scopeOwners.set(shape, [dir])
        else owners.push(dir)
      }
    }
    scopesByDir.set(dir, scopes)
  }
  const ownerOf = new Map<string, string>()
  for (const [shape, dirs] of scopeOwners) {
    const owner = dirs.find((dir) => dirs.every((other) => isDirAtOrAbove(dir, other)))
    if (owner === undefined) {
      const [first, second] = dirs as [string, string]
      throw new Error(
        `[nifra/web] ambiguous _404: "${notFoundFiles.get(first)}" and "${notFoundFiles.get(second)}" both answer unmatched URLs under "${shape.replace(/\/?\*$/, "") || "/"}"; keep one, or add a _404 in a directory that contains both`,
      )
    }
    ownerOf.set(shape, owner)
  }
  const notFounds: Record<string, NotFoundEntry> = {}
  for (const [dir, file] of notFoundFiles) {
    if (dir === "") continue
    const dirs = ancestorDirs(file)
    const middlewareIds = dirs.filter((d) => middlewareFiles.has(d)).map(middlewareIdFor)
    notFounds[notFoundIdFor(dir)] = {
      file,
      ...halves(file),
      layoutIds: dirs.filter((d) => layoutDirs.has(d)).map(layoutIdFor),
      errorIds: dirs.filter((d) => errorDirs.has(d)).map(errorIdFor),
      ...(middlewareIds.length > 0 ? { middlewareIds } : {}),
      scopes: (scopesByDir.get(dir) ?? [])
        .filter((scope) => ownerOf.get(scope.shape) === dir)
        .map(({ pattern, layoutParams, middlewareParams }) => ({
          pattern,
          layoutParams,
          ...(middlewareParams === undefined ? {} : { middlewareParams }),
        })),
    }
  }

  const loadings: Record<string, LoadingEntry> = {}
  for (const [dir, file] of loadingFiles) {
    const backend = backendByStem.get(stripExt(file))
    if (backend !== undefined) {
      throw routeError(
        `"${backend}" pairs with a _loading page, which renders in the browser only and has no backend half`,
      )
    }
    loadings[loadingIdFor(dir)] = {
      file,
      load: () =>
        importer(file)().then((front) => mergeRouteHalves(file, front, undefined, undefined)),
      layoutIds: ancestorDirs(file)
        .filter((d) => layoutDirs.has(d))
        .map(layoutIdFor),
    }
  }

  const middlewares: Record<string, LayoutEntry> = {}
  for (const [dir, backend] of middlewareFiles) {
    const loadBack = importer(backend)
    const layout = layoutDirs.has(dir) ? layouts[layoutIdFor(dir)]?.file : undefined
    middlewares[middlewareIdFor(dir)] = {
      file: backend,
      load: () =>
        loadBack().then((module) => {
          const back = module as unknown as Readonly<Record<string, unknown>>
          // Without a frontend layout there is no layout data to load: middleware is all it may hold.
          if (layout === undefined) {
            for (const name of Object.keys(back)) {
              if (name !== "middleware") {
                throw routeError(
                  `"${backend}" exports "${name}", but its directory has no _layout frontend file, so it may export only middleware`,
                )
              }
            }
          }
          return { default: back.middleware } as RouteModule
        }),
    }
  }

  for (const backend of backendByStem.values()) {
    if (pairedBackends.has(backend)) continue
    throw routeError(
      `"${backend}" has no frontend half. A backend half pairs with the file that renders its page ("${backend.replace(ROUTE_BACKEND, "")}.tsx" or another route extension); an endpoint with no page is a route in backend/app.ts`,
    )
  }

  const base: Manifest = {
    routes,
    layouts,
    errors,
    ...(Object.keys(notFounds).length > 0 ? { notFounds } : {}),
    ...(Object.keys(statusPages).length > 0 ? { statusPages } : {}),
    ...(Object.keys(loadings).length > 0 ? { loadings } : {}),
    ...(Object.keys(middlewares).length > 0 ? { middlewares } : {}),
  }
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
 * {@link enumerateStaticRoutes}.
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
  /** Concrete prerendered paths - static `prerender` routes + each `getStaticPaths` entry. */
  readonly paths: string[]
  /** Per dynamic route pattern, its `getStaticPaths` `fallback` (`"ssr"` default). `createWebApp` uses
   * `"404"` to reject an unlisted path under that route at runtime (the path simply doesn't exist). */
  readonly fallbacks: Record<string, "ssr" | "404">
}

/**
 * Enumerate the static-routing facts `prerenderRoutes` would produce - static routes opted in via
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
