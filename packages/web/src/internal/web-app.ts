import {
  type BackendMount,
  type BackendMountHandler,
  NIFRA_BACKEND_MOUNT,
} from "@nifrajs/core/mount"
import type { Platform } from "@nifrajs/core/server"
import { type ServerOptions, server } from "@nifrajs/core/server"
import type { CssLoadingMode } from "../css-contract.ts"
import { generateLlmsTxt } from "../llms-txt.ts"
import type { Manifest } from "../manifest.ts"
import type { RenderAdapter } from "../render-seam.ts"
import { createPageRequestExecutor, type NonceResolver } from "./page-execution.ts"
import { urlPartsFor } from "./request-url.ts"

export type { NonceResolver } from "./page-execution.ts"
export interface CreateWebAppOptions<Env = unknown> {
  readonly adapter: RenderAdapter
  readonly manifest: Manifest
  /** URL of the built client entry (module script) injected into every page. */
  readonly clientEntry: string
  /** Default document title for all pages. */
  readonly title?: string
  /**
   * Resolve a fresh CSP nonce for each document request. The value is applied to every
   * framework-owned executable script; return `undefined` to keep the default nonce-free output.
   * Nonce-bearing documents are marked `private, no-store` so the request-specific value is not
   * replayed by browser, CDN, or ISR caches. The resolver does not declare a CSP header because the
   * policy's allowed sources are app-specific.
   */
  readonly nonce?: NonceResolver<Env>
  /**
   * Options for the underlying `server()` - `requestTimeoutMs`, `admission`, `gracefulSignals`, and
   * the rest of {@link ServerOptions}.
   *
   * Needed because the `Server` is constructed in here, so a caller has no other way to reach its
   * constructor: a page app could set no request timeout and no capacity gate, which are exactly the
   * two knobs a production readiness check looks for. An SSR app wants them MORE than a backend does -
   * a render is slow and allocation-heavy, so a burst that a JSON API would absorb is the one that
   * exhausts the pod.
   *
   * Applies to the whole app, {@link mounts} and the {@link api} auto-mount included: the capacity gate
   * sits at the fetch entry, ahead of the request hooks those are dispatched from.
   */
  readonly server?: ServerOptions
  /**
   * Runs against the app BEFORE any page route is registered - the seam for `securityHeaders()`,
   * `requestId()`, `logger()`, a rate limit, or anything else applied with `use`.
   *
   * ```ts
   * createWebApp({
   *   …,
   *   use: (app) => {
   *     app.use(securityHeaders())
   *     app.use(requestId())
   *   },
   * })
   * ```
   *
   * A callback rather than an array because `use` is overloaded - `Middleware`, `IdentityPlugin`,
   * `ContextPlugin` - and only the real call site instantiates the right overload. The return value
   * is ignored: this is for cross-cutting concerns, not for declaring routes (declare those on the
   * returned app, where they get their types).
   *
   * **Why the timing matters.** `beforeHandle`, `afterHandle`, `around`, `derive`/`decorate`, and
   * `onError` are snapshotted into each route AS IT IS DECLARED, and `createWebApp` declares every
   * page (plus the `/*` catch-all) before it returns - so a caller's `app.use(…)` afterwards binds
   * them to nothing, silently. `requestId()` is exactly that case: it is a `derive`, so applied late
   * it leaves every page without `c.requestId`. Route assurance evidence is order-scoped the same
   * way, so a late `securityHeaders()` leaves the pages unable to PROVE the header to `nifra assure`
   * even though it does still set it.
   *
   * `onRequest`/`onResponse` (and the response header/body hooks) are app-global arrays read at
   * request time, so those alone DO work when added late. Using this seam for everything avoids
   * having to remember which is which.
   *
   * Runs ahead of the {@link mounts} / {@link api} request hooks, so an `onRequest` middleware guards
   * a mounted auth handler too.
   *
   * A `ContextPlugin` applied here takes runtime effect but cannot widen the declared return type of
   * this function, so `c.requestId` is not typed on routes you declare afterwards. Named plugins are
   * idempotent, so `app.use(requestId())` on the returned app recovers the TYPE without applying the
   * plugin a second time.
   */
  readonly use?: (app: ReturnType<typeof server<Env>>) => void
  /** Injected into each loader's `ctx.api` - typically an `inProcessClient(app)` (typed
   * per-route via `@nifrajs/client`'s `createRoutes`). Opaque to the core.
   *
   * **Auto-mount.** Every `inProcessClient(backend)` exposes the symbol-keyed platform-aware backend
   * mount interface from `@nifrajs/core/mount`; `createWebApp` also serves that backend over HTTP at
   * {@link apiPrefix} (default `/api`): a request whose pathname starts with the prefix is dispatched
   * before page routing with the same `env`/`waitUntil` platform context, and the backend's `Response`
   * is returned untouched. The mount runs in `nifra dev` too. Pass `apiPrefix: ""` to disable it. */
  readonly api?: unknown
  /** HTTP path prefix the {@link api} backend is auto-mounted at (default `"/api"`). A request whose
   * pathname is exactly the prefix or starts with `prefix + "/"` is dispatched to the backend before
   * page routing; the backend therefore defines its routes at the **full** path (`server().post("/api/
   * sync", …)`), matching the in-process `inProcessClient` call sites. Set to `""` to disable the
   * auto-mount entirely (the app serves pages only and `api` stays a loader-only `ctx.api`). Mounting
   * is also a no-op when `api` does not expose the symbol mount. */
  readonly apiPrefix?: string
  /**
   * Strip {@link apiPrefix} from the pathname before dispatching to `api` (default `false`).
   *
   * The default suits a backend that declares FULL paths (`server().post("/api/sync", …)`), which is
   * right when it is only ever mounted here. Set this when the backend declares its routes WITHOUT the
   * prefix because it also runs standalone behind its own shell, so its paths cannot carry a prefix that
   * only exists when it is mounted. Without it every request 404s inside the backend, and the workaround
   * is a `Proxy` that rewrites each URL.
   */
  readonly apiStrip?: boolean
  /**
   * Sub-apps mounted ahead of page routing - an auth handler, a webhook receiver, a stack's routes.
   *
   * Structural on purpose: anything with `{ path, app: { fetch } }` fits, so a library that exposes its
   * routes as such a list mounts as `mounts: theirRoutes` without `@nifrajs/web` taking a dependency on
   * it. `better-auth` is the motivating case - it is not a `backend` route, so `/api/auth/*` used to 404
   * silently.
   *
   * Tried longest-path-first and BEFORE the `api` mount, so a mount at `/api/auth` wins over a backend
   * at `/api` no matter which was declared first. `stripPrefix` is the per-mount form of {@link apiStrip}:
   * leave it off to pass the full path through.
   */
  readonly mounts?: ReadonlyArray<{
    readonly path: string
    readonly app: {
      fetch(request: Request, platform?: Platform<Env>): Response | Promise<Response>
    }
    readonly stripPrefix?: boolean
  }>
  /** Secret for **draft / preview mode** (see `enableDraft`). When set, a request carrying a valid
   * signed `__nifra_draft` cookie gets `ctx.draft === true` in loaders/actions (else always `false`).
   * Pair with `withISR({ draftSecret })` so editors bypass the cache. Omit to disable draft mode. */
  readonly draftSecret?: string
  /** Per-route chunk URLs (`buildClient`'s `BuildManifest.routes`) - `routeId → [layout chunks…, own
   * chunk]`. When present, each page `modulepreload`s its matched route's chunks alongside the entry,
   * so the route code downloads in parallel (no entry→route-chunk waterfall). Omit ⇒ entry-only. */
  readonly routePreload?: Readonly<Record<string, readonly string[]>>
  /** The app's bundled stylesheet URLs (`buildClient`'s `BuildManifest.css`) - the aggregate, injected
   * as `<link rel="stylesheet">` in a page's `<head>`. Used as the fallback for any route absent from
   * {@link routeStyles}. Omit ⇒ no links (dev, where Vite injects CSS, or a CSS-free app). */
  readonly styles?: readonly string[]
  /** Per-route stylesheet URLs (`buildClient`'s `BuildManifest.routeStyles`) - `routeId → [chain CSS]`.
   * When a matched route has an entry here, only those (its layout chain + own CSS) are linked instead
   * of the aggregate `styles`, so a page ships only the CSS it uses. An empty array ⇒ no `<link>` (the
   * page imports no CSS). Routes absent here fall back to `styles`. Omit ⇒ always use `styles`. */
  readonly routeStyles?: Readonly<Record<string, readonly string[]>>
  /**
   * Activation policy for framework-owned stylesheet links (default `"blocking"`). `"deferred"`
   * emits `media="print"` links; the generated client waits for them and switches them to `all` before
   * mounting. Pair with an aggregate Vite stylesheet (`cssCodeSplit: false`) to prevent lazy-prefetch
   * CSS insertion. Non-hydrated pages always keep their stylesheet links blocking.
   */
  readonly cssLoading?: CssLoadingMode
  /** SSG: the prerendered-path set (e.g. `enumerateStaticRoutes(routes).paths` or the build's
   * `prerendered.json`). Injected as `window.__NIFRA_PRERENDERED__` on every page so a client soft-nav
   * into a prerendered route fetches its static `_data.json` instead of hitting the worker. */
  readonly prerenderedPaths?: readonly string[]
  /** Publish the project's `AGENTS.md` inside `/llms.txt` and `/llms-full.txt`. **Off by default**:
   * those endpoints are public and unauthenticated, while `AGENTS.md` is a repo file written for the
   * team - unreleased feature names, internal hostnames, and "don't touch X yet" notes live there
   * routinely. Turn it on only for a repo whose guidelines you would publish as a page. */
  readonly publishLocalGuidelines?: boolean
  /** SSG: per dynamic route pattern, its `getStaticPaths` `fallback` (from `enumerateStaticRoutes` or
   * the build's `prerendered.json`). A route mapped to `"404"` rejects any path NOT in
   * `prerenderedPaths` with the 404 page - the unlisted path simply doesn't exist. `"ssr"` (the
   * default for unmapped routes) renders unlisted paths on-demand. */
  readonly staticFallbacks?: Readonly<Record<string, "ssr" | "404">>
  /** In-memory reference cache for explicitly `static` boundary values. It never persists payloads
   * across processes; operated/durable cache implementations stay outside the public framework. */
  readonly staticBoundaryCache?: import("../boundary.ts").StaticBoundaryCache
  /** Observe every loader/action failure - for error-reporting plugins (Sentry-style). Called for
   * real throws (not control-flow `Response`s like `redirect`), **before** the nearest `_error`
   * boundary renders / a soft-nav 500 / a rethrow - so it sees errors that the boundary would
   * otherwise hide. Observation only; its own throws are swallowed so a faulty reporter can't break
   * rendering. (`beforeLoader` is intentionally omitted - the core HTTP hooks already cover
   * pre-request work.) */
  readonly onLoaderError?: (
    error: unknown,
    ctx: {
      readonly request: Request
      readonly params: Readonly<Record<string, string>>
      readonly route: string
    },
  ) => void
}

/** The handler context fields createWebApp uses - a structural subset of nifra's `Context`. */
interface RouteContext<Env = unknown> {
  readonly params: Record<string, string>
  readonly req: Request
  /** Platform bindings (Workers env), forwarded to each route's loader/action as `args.env`. */
  readonly env: Env
}

/**
 * Re-issue `request` with `prefix` removed from its pathname.
 *
 * Needed because two conventions exist and both are reasonable. `createWebApp`'s auto-mount assumes a
 * backend that declares FULL paths (`server().post("/api/sync")`), which is right when the backend is
 * only ever mounted here. A backend that also runs standalone declares paths WITHOUT the prefix and
 * lets its own shell supply it - and mounting one of those here used to require the caller to wrap it
 * in a `Proxy` that rewrote every URL. Two apps wrote that same wrapper independently, which is the
 * signal that it belonged in the framework.
 *
 * The `Request` is rebuilt rather than mutated (`url` is read-only), preserving method, headers, body,
 * and duplex streaming - the body is passed through unread, so a large or streamed upload is untouched.
 */
function stripMountPrefix(request: Request, prefix: string): Request {
  const url = new URL(request.url)
  const rest = url.pathname.slice(prefix.length)
  url.pathname = rest === "" ? "/" : rest
  // `url.href`, not the `URL`: this type set only declares the string and Request overloads.
  return new Request(url.href, request)
}

/**
 * Resolve the explicit symbol-keyed backend mount interface. The symbol seam forwards platform
 * context without making web depend on client.
 */
function backendMountOf<Env>(api: unknown): BackendMountHandler<Env> | undefined {
  if ((typeof api !== "object" && typeof api !== "function") || api === null) return undefined
  const explicit = (api as Partial<BackendMount<Env>>)[NIFRA_BACKEND_MOUNT]
  if (typeof explicit !== "function") return undefined
  return (request, platform) => explicit.call(api, request, platform)
}

function requestPathOf(request: Request): string {
  try {
    const parts = urlPartsFor(request)
    return parts.pathname + parts.search
  } catch {
    return "/"
  }
}

/**
 * Build a nifra app from a route manifest: every route SSRs its layout chain via `renderPage`,
 * and a wildcard catch-all renders `_404` (or a plain 404). Reuses @nifrajs/core's router +
 * lifecycle, so matching, params, and precedence are battle-tested. fs-free - feed it a
 * manifest from `discoverRoutes` (`@nifrajs/web/fs`) at startup, so the served app stays portable.
 *
 * **Typed platform bindings.** Pass `Env` - `createWebApp<Env>({ … })` - to declare the app's Workers
 * bindings ONCE. It seeds the returned `Server`'s context with `{ env: Env }` (exactly as the backend's
 * `server<Env>()` does), so `app.fetch(req, { env })` / `toFetchHandler(app)` type-check the `env`
 * argument against the declared shape - no per-binding cast at the edge entry. Per-route loaders/actions
 * stay typed independently of this call: annotate them with `@nifrajs/client`'s `LoaderArgs<Api, Env>`
 * (same `Env`) so `ctx.env.MY_KV` is typed there too. Omit the parameter and `Env` is `unknown` - the
 * secure default; validate at the trust boundary before use.
 */
export function createWebApp<Env = unknown>(
  options: CreateWebAppOptions<Env>,
): ReturnType<typeof server<Env>> {
  const { adapter, manifest, clientEntry, title, api } = options
  // Seed the context with the declared `Env` so `app.fetch(req, { env })` / `toFetchHandler(app)` type
  // the platform bindings (see the `createWebApp` doc). The runtime `env` still arrives per-request via
  // `app.fetch(req, { env })`; this is a compile-time-only seed (`server<Env>()` casts, doesn't store).
  const app = server<Env>(options.server)
  // Before the mount hooks and before every page route, so the order-scoped hooks (`derive`,
  // `beforeHandle`, assurance evidence) actually bind to them - see the `use` option. A caller
  // cannot do this after the fact: by the time this function returns, the routes are declared.
  options.use?.(app)
  // Auto-mount the in-process backend over HTTP at `apiPrefix` (default `/api`), BEFORE page routing.
  // `onRequest` runs on the raw request ahead of the router, so this wins over the page wildcard `/*`
  // for every method (POST/GET/PUT/…) - not just the GET page routes - and a backend 404 (`/api/none`)
  // surfaces as the backend's own response, never the page 404. We dispatch the SAME `Request` object
  // (its body unread) so streamed/large bodies pass through untouched; the backend defines its routes
  // at the full prefixed path (`server().post("/api/sync", …)`), matching the `inProcessClient` call
  // sites. `apiPrefix: ""` opts out; a non-mountable `api` (no symbol mount) is left pages-only. The hook
  // is registered ONLY when both hold, so a pages-only app keeps core's synchronous no-hook fast path.
  const apiPrefix = options.apiPrefix ?? "/api"
  const apiStrip = options.apiStrip === true
  const mountedApi = backendMountOf<Env>(api)
  // Longest path first, so a more specific mount (`/api/auth`) is tried before a broader one (`/api`)
  // regardless of the order they were declared in.
  const mounts = [...(options.mounts ?? [])].sort((a, b) => b.path.length - a.path.length)
  const underPrefix = (pathname: string, prefix: string): boolean =>
    pathname === prefix || pathname.startsWith(`${prefix}/`)

  if (mounts.length > 0 || (apiPrefix !== "" && mountedApi !== undefined)) {
    app.onRequest((req, platform) => {
      const { pathname } = urlPartsFor(req)
      // Sub-app mounts win over the backend prefix: they are the more specific declaration, and an
      // auth handler mounted at `/api/auth` must not be swallowed by the backend mounted at `/api`.
      for (const mount of mounts) {
        if (!underPrefix(pathname, mount.path)) continue
        return mount.app.fetch(
          mount.stripPrefix === true ? stripMountPrefix(req, mount.path) : req,
          platform,
        )
      }
      // Exactly the prefix (`/api`) or a sub-path (`/api/…`) - NOT a sibling like `/apixyz` that merely
      // shares the prefix as a string head. Dispatch the original `req` (body intact) to the backend.
      if (mountedApi !== undefined && apiPrefix !== "" && underPrefix(pathname, apiPrefix)) {
        return mountedApi(apiStrip ? stripMountPrefix(req, apiPrefix) : req, platform)
      }
      return undefined // not an API path → continue to page routing
    })
  }
  const pageExecutor = createPageRequestExecutor<Env>({
    adapter,
    manifest,
    clientEntry,
    ...(title === undefined ? {} : { title }),
    ...(api === undefined ? {} : { api }),
    ...(options.draftSecret === undefined ? {} : { draftSecret: options.draftSecret }),
    ...(options.routePreload === undefined ? {} : { routePreload: options.routePreload }),
    ...(options.styles === undefined ? {} : { styles: options.styles }),
    ...(options.routeStyles === undefined ? {} : { routeStyles: options.routeStyles }),
    ...(options.cssLoading === undefined ? {} : { cssLoading: options.cssLoading }),
    ...(options.prerenderedPaths === undefined
      ? {}
      : { prerenderedPaths: options.prerenderedPaths }),
    ...(options.staticFallbacks === undefined ? {} : { staticFallbacks: options.staticFallbacks }),
    ...(options.staticBoundaryCache === undefined
      ? {}
      : { staticBoundaryCache: options.staticBoundaryCache }),
    ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
    ...(options.onLoaderError === undefined ? {} : { onLoaderError: options.onLoaderError }),
  })

  for (const route of manifest.routes) {
    app.register("GET", route.pattern, undefined, pageExecutor.get(route))
    app.register("POST", route.pattern, undefined, pageExecutor.post(route))
  }
  // Register llms.txt & llms-full.txt
  const llmsOptions = { includeLocalGuidelines: options.publishLocalGuidelines === true }
  app.register("GET", "/llms.txt", undefined, async () => {
    const text = await generateLlmsTxt(false, manifest.routes, api, llmsOptions)
    return new Response(text, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    })
  })

  app.register("GET", "/llms-full.txt", undefined, async () => {
    const text = await generateLlmsTxt(true, manifest.routes, api, llmsOptions)
    return new Response(text, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    })
  })

  // Wildcard catch-all: unmatched paths render `_404` (404), or a plain text 404 if absent.
  app.register("GET", "/*", undefined, (c: RouteContext<Env>) =>
    pageExecutor.notFound(c.req, c.env, requestPathOf(c.req)),
  )

  return app
}
