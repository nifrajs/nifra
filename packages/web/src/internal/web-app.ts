import { emitRequestErrorLog } from "@nifrajs/core/edge-kit"
import { jsonLogger } from "@nifrajs/core/logger"
import {
  type BackendEvidenceProvider,
  type BackendMount,
  type BackendWebSocketMountHandler,
  NIFRA_BACKEND_EVIDENCE,
  NIFRA_BACKEND_MOUNT,
  NIFRA_BACKEND_WS_MOUNT,
  NIFRA_BACKEND_WS_RUNTIME,
  preRouteMountPaths,
} from "@nifrajs/core/mount"
import { withResponseObserver } from "@nifrajs/core/response-observer"
import type { MountableApp, MountOptions } from "@nifrajs/core/server"
import { replacedRequestOf, type ServerOptions, server } from "@nifrajs/core/server"
import {
  type CspHeaderContext,
  type CspPolicy,
  cspNonceResolver,
  DOCUMENT_POLICY,
  isCspPolicy,
  nonceCspPolicy,
} from "../csp.ts"
import type { CssLoadingMode } from "../css-contract.ts"
import {
  type BuildAssetSet,
  type HostPolicy,
  hostPolicyGate,
  isHostPolicy,
} from "../host-policy.ts"
import { CACHE_CHANNEL } from "../isr.ts"
import { generateLlmsTxt } from "../llms-txt.ts"
import type { Manifest } from "../manifest.ts"
import type { RenderAdapter } from "../render-seam.ts"
import { createMatcher, PRERENDERED_LIST_PATH } from "../router.ts"
import type { EvidenceAncestry } from "./evidence-traversal.ts"
import { identityEpochHook, type KeepAliveServerOptions } from "./identity-epoch.ts"
import { INVALIDATION, type InvalidationOp, invalidationOf } from "./invalidation-contract.ts"
import { LIVE_ATTACH, type LiveAttachment, type LiveRuntimeHandle } from "./live-contract.ts"
import { formatShadowedPages, shadowedPages } from "./mount-shadow.ts"
import { createPageRequestExecutor, type NonceResolver, type PageI18n } from "./page-execution.ts"
import { PPR_SERVER, PPR_SETUP, type PprSetup } from "./ppr/contract.ts"
import { type PrerenderedPages, servePrerenderedPages } from "./prerendered-pages.ts"
import type { RevalidateResult } from "./render-document.ts"

export type { NonceResolver } from "./page-execution.ts"

/** An app's locale routing as `createWebApp` reads it: what `defineI18nRouting()` from
 * `@nifrajs/i18n/routing` returns. */
export interface WebAppI18n {
  readonly locales: {
    readonly default: string
    /** Served locale keys, in registry order. */
    readonly served: readonly string[]
    documentMeta(key: string): { readonly lang: string; readonly dir: "ltr" | "rtl" }
  }
  localeOf(path: string): string
  matchSegment(
    value: string | undefined,
    pathname: string,
  ):
    | { readonly kind: "ok" | "not-found" }
    | { readonly kind: "redirect"; readonly location: string }
}

function pageI18n(routing: WebAppI18n): PageI18n {
  const { locales } = routing
  if (
    typeof routing.localeOf !== "function" ||
    typeof routing.matchSegment !== "function" ||
    typeof locales?.documentMeta !== "function" ||
    !Array.isArray(locales.served)
  ) {
    throw new TypeError(
      "[nifra/web] createWebApp `i18n` must be the router defineI18nRouting() from @nifrajs/i18n/routing returns",
    )
  }
  return {
    locales: {
      default: locales.default,
      locales: locales.served.map((key) => {
        const { lang, dir } = locales.documentMeta(key)
        return { key, lang, dir }
      }),
    },
    localeOf: (path) => routing.localeOf(path),
    matchSegment: (value, pathname) => routing.matchSegment(value, pathname),
  }
}

export interface CreateWebAppOptions<Env = unknown> {
  readonly serverComponents?: import("../server-components/types.ts").ServerComponentRuntime
  readonly adapter: RenderAdapter
  readonly manifest: Manifest
  /** Cache production module imports and layout preparation, never request data. Defaults to NODE_ENV === "production"; disable for a mutable manifest. */
  readonly cacheRouteModules?: boolean
  /** URL of the built client entry (module script) injected into every page. */
  readonly clientEntry: string
  /** Default document title for all pages. */
  readonly title?: string
  /**
   * Resolve a fresh CSP nonce for each document request. The value is applied to every
   * framework-owned executable script; return `undefined` to keep the default nonce-free output.
   * Nonce-bearing documents are marked `private, no-store` so the request-specific value is not
   * replayed by browser, CDN, or ISR caches. Pass {@link cspHeader} to have nifra write the
   * Content-Security-Policy header from the same value.
   */
  readonly nonce?: NonceResolver<Env>
  /**
   * Build the Content-Security-Policy value for each document a {@link nonce} app renders, or return
   * `undefined` to send none. nifra sets it on every document it renders - pages, status pages,
   * `_error`, streamed and deferred documents - from the nonce it put on that document's scripts, so
   * the header never depends on which `Request` object a wrapper holds. `sources` is the
   * `script-src` list the document needs: `'nonce-…'` plus a `'sha256-…'` hash for each constant
   * inline script nifra writes, which covers a document the resolver left nonce-free.
   *
   * ```ts
   * cspHeader: ({ sources }) => `default-src 'self'; script-src 'self' ${sources}; object-src 'none'`
   * ```
   *
   * Needs `nonce`; `csp` writes its own header, so the two are refused together.
   */
  readonly cspHeader?: (context: CspHeaderContext) => string | undefined
  /**
   * A hash-based Content-Security-Policy from `createCspPolicy`, instead of `nonce`. A document then
   * carries a nonce only when it needs one (it `defer()`s a value, or `meta` names the nonce in
   * `unsafeInlineScript`); every other page is nonce-free, gets the same CSP header on every request,
   * and stays cacheable by `withISR` or a CDN. `meta` still receives a nonce to name.
   */
  readonly csp?: CspPolicy
  /**
   * Partial prerendering, from `partialPrerendering()` in `@nifrajs/web/ppr`. A route whose backend
   * half exports `shellLoader` streams a shell shared by every visitor, then each `dynamic` boundary
   * as it settles. `csp` (hashes) is optional; `nonce` is refused, since a per-request nonce would
   * make every shell unique.
   */
  readonly ppr?: PprSetup
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
   * page (plus the `/*` catch-all) before it returns - so a caller's `app.use(…)` afterwards would
   * bind them to no page, and outside production it throws (`HOOK_AFTER_PAGES`). `requestId()` is
   * exactly that case: it is a `derive`, so applied late it would leave every page without
   * `c.requestId`. A `group()` is its own scope and stays allowed. Route assurance evidence is order-scoped the same
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
   * mount interface from `@nifrajs/core/mount`; given an {@link apiPrefix}, `createWebApp` also serves
   * that backend over HTTP there: a request whose pathname starts with the prefix is dispatched before
   * page routing with the same `env`/`waitUntil` platform context, and the backend's `Response` is
   * returned untouched. The mount runs in `nifra dev` too. Without `apiPrefix` the backend is
   * loader-only.
   *
   * **Request-scoped loader calls.** While a page renders, its loaders, actions and boundaries get a
   * `ctx.api` bound to that request's platform identity: a backend handler reached through it sees the
   * visitor's `c.clientIp` (derived under this app's `server.clientIp` trust declaration), `c.env` and
   * `c.waitUntil`, so a per-caller rate limit or audit field keys on the real visitor. `c.clientIp` is
   * the supported way to read the caller - identity travels in the platform, so rebuilding a `Request`
   * does not lose it. Headers do NOT travel: the page request's `cookie` and `authorization` are never
   * copied, so a loader call is anonymous unless the loader passes headers on the call itself. */
  readonly api?: unknown
  /** HTTP path prefix the {@link api} backend is mounted at, such as `"/api"`. A request whose
   * pathname is exactly the prefix or starts with `prefix + "/"` is dispatched to the backend before
   * page routing; the backend therefore defines its routes at the **full** path (`server().post("/api/
   * sync", …)`), matching the in-process `inProcessClient` call sites. Unset or `""`, nothing is
   * mounted: the app serves pages only and `api` stays a loader-only `ctx.api`. Mounting is also a
   * no-op when `api` does not expose the symbol mount.
   *
   * A page file under the prefix (`routes/api/report.tsx`) could never render - the backend answers
   * first and its 404 is final - so `createWebApp` throws, naming the file. The same holds for every
   * other pre-route mount. */
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
   * leave it off to pass the full path through. `opaque` states why a mount whose routes nifra cannot
   * read (better-auth's handler) is outside assurance; it is then listed as a known gap, with any
   * routes it declares reported as declared.
   */
  readonly mounts?: ReadonlyArray<{
    readonly path: string
    readonly app: MountableApp<Env>
    readonly stripPrefix?: boolean
    readonly priority?: number
    readonly fallbackOn?: 404
    readonly opaque?: MountOptions<Env>["opaque"]
  }>
  /** Secret for **draft / preview mode** (see `enableDraft`). When set, a request carrying a valid
   * signed `__nifra_draft` cookie gets `ctx.draft === true` in loaders/actions (else always `false`).
   * Pair with `withISR({ draftSecret })` so editors bypass the cache. Omit to disable draft mode. */
  readonly draftSecret?: string
  /**
   * Live data refresh, from `live()` in `@nifrajs/web/live`. Loaders declare keys with `ctx.live()`;
   * the app answers live loads at the runtime's load endpoint. Omit and nothing live is loaded.
   */
  readonly live?: LiveRuntimeHandle
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
  /** Locale key -> copy chunk URL (`buildClient`'s `BuildManifest.copyChunks`, the server manifest's
   * `copyChunks`). A production client build moves copy tables (`@nifrajs/i18n/copy`) into one chunk per
   * locale; each page lists them for the browser and preloads its own. Omit ⇒ tables keep their values. */
  readonly copyChunks?: Readonly<Record<string, string>>
  /**
   * The app's locale routing, `defineI18nRouting()` from `@nifrajs/i18n/routing`, registered once:
   * export it as `i18n` from `backend/framework.ts`. Every document then takes its locale from the
   * URL: `<html lang dir>` from the registry unless the route's meta sets `lang`, a `Content-Language`
   * header, and the locale each adapter's `useLocale()` and `<I18nProvider>` read. A route under a
   * `[lang]` or `[[lang]]` directory is checked with its `matchSegment()` before any middleware: an
   * unserved locale, or a page missing from it, is a 404, and a non-canonical prefix (`/en/x` when the
   * default is unprefixed) redirects with a 308.
   */
  readonly i18n?: WebAppI18n
  /**
   * Activation policy for framework-owned stylesheet links (default `"blocking"`). `"deferred"`
   * emits `media="print"` links; the generated client waits for them and switches them to `all` before
   * mounting. Pair with an aggregate Vite stylesheet (`cssCodeSplit: false`) to prevent lazy-prefetch
   * CSS insertion. Non-hydrated pages always keep their stylesheet links blocking.
   */
  readonly cssLoading?: CssLoadingMode
  /** SSG: the prerendered-path set (e.g. `enumerateStaticRoutes(routes).paths` or the build's
   * `prerendered.json`). Handed over as `window.__NIFRA_PRERENDERED__` on every page so a client soft-nav
   * into a prerendered route fetches its static `_data.json` instead of hitting the worker, unless the
   * target carries a query string, which renders on demand as a hard request does. A set over
   * 4 KB of JSON is served once from `/__nifra/prerendered.json?v=<version>`, cacheable for good, and
   * pages hand over only that URL; `prerenderRoutes` writes the file into a static output. */
  readonly prerenderedPaths?: readonly string[]
  /**
   * Pages a self-hosted build prerendered, answered from their file instead of rendered. `nifra build
   * --target bun|node` wires this from its prerender pass. The page is served from the page route,
   * so `use` middleware and every request hook run first; a request with a query string, a navigation
   * data or component request, or a draft-mode visitor renders on demand as before. Ignored with
   * {@link nonce}, whose documents need a nonce minted for their request.
   */
  readonly prerenderedPages?: PrerenderedPages
  /**
   * Which pages and files each host serves, from `createHostPolicy()`. Evaluated before everything
   * else the app answers (prerendered pages, mounts, the API, every page) and, in a `nifra build`
   * server entry, before its static files too. A refused path answers the policy's refusal.
   */
  readonly hostPolicy?: HostPolicy
  /**
   * Which cookies say who is signed in, for an app with a `keepAlive` route. A response that changes
   * or deletes one rotates the readable identity epoch cookie, and every tab drops the pages it kept
   * for the previous visitor. The session cookies of `@nifrajs/auth` and Auth.js count under their
   * default names, Better Auth's under any `cookiePrefix`; name any other in `identityCookies`. An app
   * run by `nifra dev` and `nifra build` exports this from `backend/framework.ts`. Development reports, once per
   * name, an `HttpOnly` cookie that changes and is in neither list (`NIFRA_KEEPALIVE_IDENTITY_COOKIE`).
   */
  readonly keepAlive?: KeepAliveServerOptions
  /**
   * The files the build emitted, by request path: `buildAssets` from the generated server manifest.
   * A {@link hostPolicy} rule's `buildAssets` token matches exactly these. `nifra dev` serves the
   * client bundle and `public/` ahead of the app, so the app's own check never sees them there.
   */
  readonly buildAssets?: BuildAssetSet
  /** Publish the project's `AGENTS.md` inside `/llms.txt` and `/llms-full.txt`. **Off by default**:
   * those endpoints are public and unauthenticated, while `AGENTS.md` is a repo file written for the
   * team - unreleased feature names, internal hostnames, and "don't touch X yet" notes live there
   * routinely. Turn it on only for a repo whose guidelines you would publish as a page. */
  readonly publishLocalGuidelines?: boolean
  /** Serve `/llms.txt` and `/llms-full.txt`: the page routes, and the backend routes when the backend
   * is mounted over HTTP at {@link apiPrefix}, with their request and response schemas in the full
   * text. **Off by default**: both are public and unauthenticated, and they list every route, admin
   * and internal ones included. Turn it on for an app whose whole surface you would publish. */
  readonly llmsTxt?: boolean
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
   * boundary renders / a soft-nav 500 / a rethrow. A failure a boundary answers is also written to the
   * server's `logger` (under its `errorLogDetail`) whether or not this is set, exactly as an unhandled
   * error is. Observation only; its own throws are swallowed so a faulty reporter can't break
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
/** Publish what a write named, for an app with `live` and no cache wrapper to run the pipeline. */
async function publishOwn(
  op: InvalidationOp,
  request: Request,
  publish: (keys: readonly string[]) => Promise<void>,
): Promise<void> {
  const { settleInvalidation } = await import("./invalidation.ts")
  await settleInvalidation(op, { publish }, request, undefined)
}

/**
 * Resolve the explicit symbol-keyed backend mount interface. The symbol seam forwards platform
 * context without making web depend on client.
 */
function backendMountOf<Env>(api: unknown): MountableApp<Env> | undefined {
  if ((typeof api !== "object" && typeof api !== "function") || api === null) return undefined
  const explicit = (api as Partial<BackendMount<Env>>)[NIFRA_BACKEND_MOUNT]
  if (typeof explicit !== "function") return undefined
  const websocket = (api as Partial<BackendMount<Env>>)[NIFRA_BACKEND_WS_MOUNT]
  const runtime = (api as Partial<BackendMount<Env>>)[NIFRA_BACKEND_WS_RUNTIME]
  const evidence = (api as Partial<BackendMount<Env>>)[NIFRA_BACKEND_EVIDENCE]
  const mount: {
    fetch: MountableApp<Env>["fetch"]
    resolveWebSocketUpgrade?: BackendWebSocketMountHandler<Env>
    [NIFRA_BACKEND_WS_RUNTIME]?: NonNullable<BackendMount<Env>[typeof NIFRA_BACKEND_WS_RUNTIME]>
    [NIFRA_BACKEND_EVIDENCE]?: BackendEvidenceProvider
  } = {
    fetch: (request, platform) => explicit.call(api, request, platform),
  }
  if (typeof websocket === "function") {
    mount.resolveWebSocketUpgrade = (request, platform) => websocket.call(api, request, platform)
  }
  if (typeof runtime === "function") mount[NIFRA_BACKEND_WS_RUNTIME] = runtime
  if (typeof evidence === "function") mount[NIFRA_BACKEND_EVIDENCE] = evidence
  return mount
}

/** A provider a web app composes: it also takes the chain of web providers above it, which a
 * provider that composes nothing ignores. */
type ComposedEvidenceProvider = (ancestry?: EvidenceAncestry) => ReturnType<BackendEvidenceProvider>

function evidenceProviderOf(value: unknown): ComposedEvidenceProvider | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined
  const provider = (value as { [NIFRA_BACKEND_EVIDENCE]?: unknown })[NIFRA_BACKEND_EVIDENCE]
  return typeof provider === "function" ? (provider as ComposedEvidenceProvider) : undefined
}

function mountPathPrefix(path: string): string {
  const withoutWildcard = path.endsWith("/*") ? path.slice(0, -2) : path
  if (withoutWildcard === "" || withoutWildcard === "/") return ""
  // Index-scan instead of `/\/+$/`: mount paths can be library input, and the
  // unanchored-start trailing-run replacement can backtrack quadratically.
  let end = withoutWildcard.length
  while (end > 0 && withoutWildcard.charCodeAt(end - 1) === 47 /* '/' */) end--
  return withoutWildcard.slice(0, end)
}

/** The server's own error log, for page failures an `_error` boundary answers before it sees them. */
function boundaryErrorLog(
  options: ServerOptions | undefined,
): (error: unknown, request: Request) => void {
  const logger = options?.logger ?? jsonLogger()
  const detail = options?.errorLogDetail ?? "full"
  return (error, request) => emitRequestErrorLog(logger, detail, error, { req: request })
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
  if ("experimental" in options) {
    throw new TypeError(
      "[nifra/web] createWebApp `experimental.ppr` is now `ppr`: pass partialPrerendering() as createWebApp({ ppr })",
    )
  }
  if (options.csp !== undefined && options.nonce !== undefined) {
    throw new TypeError("[nifra/web] createWebApp takes `csp` or `nonce`, not both")
  }
  if (options.csp !== undefined && !isCspPolicy(options.csp)) {
    throw new TypeError("[nifra/web] createWebApp `csp` must come from createCspPolicy()")
  }
  if (options.cspHeader !== undefined) {
    if (typeof options.cspHeader !== "function") {
      throw new TypeError("[nifra/web] createWebApp `cspHeader` must be a function")
    }
    if (options.csp !== undefined) {
      throw new TypeError(
        "[nifra/web] createWebApp takes `csp` or `cspHeader`, not both: `csp` writes its own header",
      )
    }
    if (options.nonce === undefined) {
      throw new TypeError(
        "[nifra/web] createWebApp `cspHeader` writes the header of `nonce` documents: pass `nonce`, or use `csp: createCspPolicy(...)`",
      )
    }
    if (options.nonce.onResponse !== undefined) {
      throw new TypeError(
        "[nifra/web] createWebApp `cspHeader` and a createNonceResolver({ header }) both write the CSP header: keep one",
      )
    }
  }
  const nonceCsp = options.cspHeader === undefined ? undefined : nonceCspPolicy(options.cspHeader)
  // Seed the context with the declared `Env` so `app.fetch(req, { env })` / `toFetchHandler(app)` type
  // the platform bindings (see the `createWebApp` doc). The runtime `env` still arrives per-request via
  // `app.fetch(req, { env })`; this is a compile-time-only seed (`server<Env>()` casts, doesn't store).
  const app = server<Env>(options.server)
  // First of all: a host's refused path must not reach a rate limiter, a mount or a page.
  if (options.hostPolicy !== undefined) {
    if (!isHostPolicy(options.hostPolicy)) {
      throw new TypeError("[nifra/web] createWebApp `hostPolicy` must come from createHostPolicy()")
    }
    app.use(hostPolicyGate(options.hostPolicy, options.buildAssets))
  }
  // Before every app hook: a live load becomes the target page's GET here, so each hook, middleware,
  // gate and loader sees that path once, as a navigation would.
  const liveAttachment: LiveAttachment | undefined = options.live?.[LIVE_ATTACH]({
    matchRoute: (path) => pageExecutor.matchRoute(path),
    app,
  })
  if (liveAttachment !== undefined) app.onRequest(liveAttachment.onRequest)
  // Before the mount hooks and before every page route, so the order-scoped hooks (`derive`,
  // `beforeHandle`, assurance evidence) actually bind to them - see the `use` option. A caller
  // cannot do this after the fact: by the time this function returns, the routes are declared.
  options.use?.(app)
  if (options.serverComponents !== undefined) {
    const runtime = options.serverComponents
    // A route whose holes show server components is one visitor's too.
    const match = createMatcher(
      manifest.routes
        .filter((route) => runtime.owns(route.id) || runtime.hosts?.(route.id) === true)
        .map((route) => ({ routeId: route.id, pattern: route.pattern })),
    )
    const privateRoute = (request: Request): boolean =>
      request.headers.has("x-nifra-component") || match(new URL(request.url).pathname) !== undefined
    Object.defineProperty(app, Symbol.for("nifra.web.private-route"), { value: privateRoute })
    app.onResponse((response, request) => {
      if (!privateRoute(request)) return response
      const headers = new Headers(response.headers)
      headers.set("cache-control", "private, no-store")
      const vary = new Set(
        (headers.get("vary") ?? "")
          .split(",")
          .map((name) => name.trim().toLowerCase())
          .filter(Boolean),
      )
      vary.add("x-nifra-component")
      vary.add("x-nifra-data")
      headers.set("vary", [...vary].join(", "))
      headers.delete("x-nifra-isr-revalidate")
      headers.delete("x-nifra-isr-tags")
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    })
  }
  // A resolver created by `createNonceResolver({ header })` carries a paired response hook. Register it
  // after caller middleware so its request-specific CSP value is the last default applied to a page.
  const nonceResponse = options.nonce?.onResponse
  if (nonceResponse !== undefined) app.onResponse(nonceResponse)
  // How this app's documents meet a CSP, for wrappers that cache them (`withISR` warns on "nonce").
  const documentPolicy =
    options.csp !== undefined ? "hash" : options.nonce !== undefined ? "nonce" : undefined
  if (documentPolicy !== undefined) {
    Object.defineProperty(app, DOCUMENT_POLICY, { value: documentPolicy })
  }
  const cacheChannel = { enabled: false }
  Object.defineProperty(app, CACHE_CHANNEL, {
    value: () => {
      cacheChannel.enabled = true
    },
  })
  // One owner per write. A cache wrapper that opened the channel runs the whole pipeline and takes
  // the operation here, by the request it passed in; without one, the app publishes the write's keys
  // and tags itself, and a write with nothing to publish needs nothing at all.
  const handedOver = new WeakMap<Request, InvalidationOp>()
  const live = options.live
  const publish =
    live === undefined ? undefined : (keys: readonly string[]) => live.publish(...keys)
  Object.defineProperty(app, INVALIDATION, {
    value: {
      take: (request: Request): InvalidationOp | undefined => {
        const op = handedOver.get(request)
        handedOver.delete(request)
        return op
      },
      publish,
    },
  })
  const invalidate = (
    revalidation: RevalidateResult<unknown>,
    request: Request,
  ): Promise<void> | undefined => {
    if (cacheChannel.enabled) {
      const op = invalidationOf(revalidation)
      // Every request in a hook's replacement chain: the wrapper holds the first one.
      for (
        let held: Request | undefined = request;
        held !== undefined;
        held = replacedRequestOf(held)
      )
        handedOver.set(held, op)
      return undefined
    }
    // Paths alone refresh only the submitting page, which the response header already does.
    const named = revalidation.__nifraInvalidate
    if (publish === undefined || named === undefined || named.keys.length + named.tags.length === 0)
      return undefined
    return publishOwn(invalidationOf(revalidation), request, publish)
  }
  // Mount the in-process backend over HTTP at `apiPrefix`, when one is given, BEFORE page routing.
  // Core's pre-route mount seam runs before the page wildcard `/*`; parent request hooks run first,
  // child request hooks run inside the mount, and parent response hooks still wrap the result.
  // The mount handles every HTTP method and preserves backend 404 responses instead of letting the
  // page catch-all render them. We dispatch the same `Request` object (its body unread), so
  // streamed/large bodies pass through untouched. The backend defines full prefixed paths
  // (`server().post("/api/sync", …)`) unless `apiStrip` is enabled. Without a prefix, or with a
  // non-mountable `api`, the backend is loader-only and pages-only apps keep the no-mount fast path.
  const apiPrefix = options.apiPrefix ?? ""
  const apiStrip = options.apiStrip === true
  const mountedApi = backendMountOf<Env>(api)
  // Longest path first, so a more specific mount (`/api/auth`) is tried before a broader one (`/api`)
  // regardless of the order they were declared in.
  const configuredMounts: readonly MountOptions<Env>[] = Object.freeze(
    (options.mounts ?? []).map(
      (mount): MountOptions<Env> => ({
        path: mount.path,
        app: mount.app,
        ...(mount.stripPrefix === undefined ? {} : { stripPrefix: mount.stripPrefix }),
        ...(mount.priority === undefined ? {} : { priority: mount.priority }),
        ...(mount.fallbackOn === undefined ? {} : { fallbackOn: mount.fallbackOn }),
        ...(mount.opaque === undefined ? {} : { opaque: mount.opaque }),
      }),
    ),
  )
  const mounts: Array<MountOptions<Env>> = [...configuredMounts]
  if (mountedApi !== undefined && apiPrefix !== "") {
    mounts.push({ path: apiPrefix, app: mountedApi, stripPrefix: apiStrip })
  }
  for (const mount of mounts) app.mount(mount)
  // Read back the server's own mount table, so a mount added in `use` counts as well: a page under any
  // pre-route mount is unreachable, and serving it as a silent 404 hides that.
  const shadowed = shadowedPages(manifest, preRouteMountPaths(app))
  if (shadowed.length > 0) throw new Error(`[nifra/web] ${formatShadowedPages(shadowed)}`)
  const ownPatterns = new Set(manifest.routes.map((route) => route.pattern))
  const prerenderedList = ownPatterns.has(PRERENDERED_LIST_PATH)
    ? undefined
    : servedPrerenderedList(options.prerenderedPaths)
  const ppr = options.ppr?.[PPR_SETUP]({
    adapter,
    // biome-ignore lint/plugin/noConditionalEmptyObjectSpread: partial prerendering lists its scripts by hash only under an app's own policy.
    ...(options.csp === undefined ? {} : { csp: options.csp }),
    // The content-hashed entry changes with every client build; the store is per process.
    deployment: clientEntry,
    perRequestNonce: options.nonce !== undefined,
  })
  const pageExecutor = createPageRequestExecutor<Env>({
    ...(options.cacheRouteModules === undefined
      ? {}
      : { cacheRouteModules: options.cacheRouteModules }),
    ...(options.serverComponents === undefined
      ? {}
      : { serverComponents: options.serverComponents }),
    ...(options.serverComponents === undefined
      ? {}
      : {
          rerenderOwnerGET: async (
            request: Request,
            context: import("./page-execution.ts").PageRouteContext<Env>,
          ) =>
            app.fetch(request, {
              env: context.env,
              ...(context.waitUntil === undefined ? {} : { waitUntil: context.waitUntil }),
              ...(context.clientIp === undefined ? {} : { clientIp: context.clientIp }),
            }),
        }),
    adapter,
    manifest,
    clientEntry,
    ...(title === undefined ? {} : { title }),
    ...(api === undefined ? {} : { api }),
    ...(options.draftSecret === undefined ? {} : { draftSecret: options.draftSecret }),
    ...(options.routePreload === undefined ? {} : { routePreload: options.routePreload }),
    ...(options.styles === undefined ? {} : { styles: options.styles }),
    ...(options.routeStyles === undefined ? {} : { routeStyles: options.routeStyles }),
    ...(options.copyChunks === undefined ? {} : { copyChunks: options.copyChunks }),
    ...(options.i18n === undefined ? {} : { i18n: pageI18n(options.i18n) }),
    ...(options.cssLoading === undefined ? {} : { cssLoading: options.cssLoading }),
    ...(options.prerenderedPaths === undefined
      ? {}
      : { prerenderedPaths: options.prerenderedPaths }),
    ...(prerenderedList === undefined ? {} : { prerenderedListUrl: prerenderedList.url }),
    ...(options.staticFallbacks === undefined ? {} : { staticFallbacks: options.staticFallbacks }),
    ...(options.staticBoundaryCache === undefined
      ? {}
      : { staticBoundaryCache: options.staticBoundaryCache }),
    ...(options.nonce === undefined
      ? {}
      : nonceCsp === undefined
        ? { nonce: options.nonce }
        : { nonce: options.nonce, csp: nonceCsp }),
    ...(options.csp === undefined
      ? {}
      : { nonce: cspNonceResolver(options.csp) as NonceResolver<Env>, csp: options.csp }),
    ...(options.onLoaderError === undefined ? {} : { onLoaderError: options.onLoaderError }),
    logBoundaryError: boundaryErrorLog(options.server),
    cacheChannel,
    ...(ppr === undefined ? {} : { ppr }),
    invalidate,
    liveLoadOf: liveAttachment?.loadOf,
    liveSeedOf: liveAttachment?.seedOf,
  })
  if (ppr !== undefined) {
    Object.defineProperty(app, PPR_SERVER, { value: ppr.server })
    app.register("POST", ppr.cancelPath, undefined, (c: { readonly req: Request }) =>
      ppr.cancel(c.req),
    )
  }

  // A nonce app's documents authorize their scripts per request, which a file rendered once cannot.
  const prerendered =
    options.prerenderedPages === undefined || options.nonce !== undefined
      ? undefined
      : servePrerenderedPages(options.prerenderedPages, options.draftSecret)
  let ownsRootCatchAll = false
  for (const route of manifest.routes) {
    const pattern = route.pattern
    if (pattern.startsWith("/*")) ownsRootCatchAll = true
    const render = pageExecutor.get(route)
    app.register(
      "GET",
      pattern,
      options.serverComponents?.owns(route.id) ||
        options.serverComponents?.hosts?.(route.id) === true
        ? { capabilities: options.serverComponents.capabilities(route.id) }
        : undefined,
      prerendered === undefined ? render : prerendered(render),
    )
    app.register("POST", pattern, undefined, pageExecutor.post(route))
  }
  // llms.txt & llms-full.txt describe what a visitor can reach: the pages, and the backend only when it
  // is served over HTTP - a backend the loaders call in-process has no public surface to describe. An
  // app route at either path takes precedence, and each text is built once per app.
  if (options.llmsTxt === true) {
    const llmsOptions = {
      includeLocalGuidelines: options.publishLocalGuidelines === true,
      apiPathPrefix: apiStrip ? mountPathPrefix(apiPrefix) : "",
    }
    const publicApi = mountedApi !== undefined && apiPrefix !== "" ? api : undefined
    for (const [path, full] of [
      ["/llms.txt", false],
      ["/llms-full.txt", true],
    ] as const) {
      if (ownPatterns.has(path)) continue
      let text: Promise<string> | undefined
      app.register("GET", path, undefined, async () => {
        text ??= generateLlmsTxt(full, manifest.routes, publicApi, llmsOptions).catch((error) => {
          text = undefined
          throw error
        })
        return new Response(await text, {
          headers: { "content-type": "text/plain; charset=utf-8" },
        })
      })
    }
  }

  if (prerenderedList !== undefined) {
    const { body, version } = prerenderedList
    app.register(
      "GET",
      PRERENDERED_LIST_PATH,
      undefined,
      (c: { readonly req: Request }) =>
        new Response(body, {
          headers: {
            "content-type": "application/json",
            // Only the versioned URL pages hand over is immutable; a bare request gets today's list.
            "cache-control":
              new URL(c.req.url).searchParams.get("v") === version
                ? "public, max-age=31536000, immutable"
                : "no-cache",
          },
        }),
    )
  }

  // Wildcard catch-all: unmatched paths render the nearest `_404` (404), or a plain text 404 if
  // absent. A root catch-all page (`[...slug].tsx`) already answers every path, the root included,
  // and the router refuses a second `/*` under another param name.
  if (!ownsRootCatchAll) app.register("GET", "/*", undefined, pageExecutor.fallback)

  // Last, after every hook the caller's `use` added: a cookie any of them sets is seen here.
  if (manifest.routes.some((route) => route.keepAlive === true)) {
    // As for error details: only a run that says it is development or test reports, and an unset
    // NODE_ENV (an unbuilt `bun app.ts`, a Worker) counts as production.
    const nodeEnv = typeof process === "undefined" ? undefined : process.env?.NODE_ENV
    app.use(
      withResponseObserver({
        onResponseHeaders: identityEpochHook(
          options.keepAlive ?? {},
          nodeEnv === "development" || nodeEnv === "test",
        ),
      }),
    )
  }

  const evidenceProvider: ComposedEvidenceProvider = async (passed) => {
    const { traverseEvidence } = await import("./evidence-traversal.ts")
    return traverseEvidence(evidenceProvider, passed, async (ancestry) => {
      const { composeProjectEvidence, snapshotProjectEvidence } = await import(
        "@nifrajs/core/evidence"
      )
      const parts: Array<{
        readonly evidence: import("@nifrajs/core/evidence").ProjectEvidenceSnapshot
        readonly pathPrefix?: string
      }> = [{ evidence: snapshotProjectEvidence(app) }]
      for (const mount of configuredMounts) {
        const provider = evidenceProviderOf(mount.app)
        if (provider === undefined) {
          // A declared opaque mount reaches the snapshot as a known gap, through this app's own
          // mount reflection above.
          if (mount.opaque !== undefined) continue
          throw new Error(
            `[nifra/web] cannot compose assurance evidence: mount "${mount.path}" has no token-only evidence provider - declare why it is not analyzed with { opaque: "<reason>" }`,
          )
        }
        parts.push({
          evidence: await provider.call(mount.app, ancestry),
          ...(mount.stripPrefix === true ? { pathPrefix: mountPathPrefix(mount.path) } : {}),
        })
      }
      if (mountedApi !== undefined && apiPrefix !== "") {
        const provider = evidenceProviderOf(api)
        if (provider === undefined) {
          throw new Error(
            `[nifra/web] cannot compose assurance evidence: auto-mounted API at "${apiPrefix}" has no token-only evidence provider`,
          )
        }
        parts.push({
          evidence: await provider.call(api, ancestry),
          // biome-ignore lint/plugin/noConditionalEmptyObjectSpread: Evidence paths acquire a prefix only when the mounted backend strips it.
          ...(apiStrip ? { pathPrefix: mountPathPrefix(apiPrefix) } : {}),
        })
      }
      return composeProjectEvidence(parts)
    })
  }
  Object.defineProperty(app, NIFRA_BACKEND_EVIDENCE, {
    configurable: false,
    enumerable: false,
    value: evidenceProvider,
    writable: false,
  })
  // Core's dev-time hook audit reads this: an order-scoped hook added from here on skips every page.
  Object.defineProperty(app, Symbol.for("nifra.web.pagesDeclared"), { value: true })

  return app
}

/** Resolve one composed, token-only evidence snapshot for a web app and its mounted surfaces. */
export async function webProjectEvidence(
  source: unknown,
): Promise<import("@nifrajs/core/evidence").ProjectEvidenceSnapshot> {
  const provider = evidenceProviderOf(source)
  if (provider === undefined) {
    throw new TypeError("webProjectEvidence(): expected an app created by createWebApp")
  }
  return provider.call(source)
}

// Up to this many characters of JSON, the prerendered set rides inline in each page's handover.
const INLINE_PRERENDERED_CHARS = 4096

/** The prerendered set as a served, content-versioned list, when it is too large to inline. */
function servedPrerenderedList(
  paths: readonly string[] | undefined,
): { readonly body: string; readonly version: string; readonly url: string } | undefined {
  if (paths === undefined || paths.length === 0) return undefined
  const body = JSON.stringify(paths)
  if (body.length <= INLINE_PRERENDERED_CHARS) return undefined
  // FNV-1a: a version that changes with the list is all the URL needs; a stale cached list only
  // costs a fallback to the dynamic data request.
  let hash = 0x811c9dc5
  for (let i = 0; i < body.length; i++) hash = Math.imul(hash ^ body.charCodeAt(i), 0x01000193)
  const version = (hash >>> 0).toString(16).padStart(8, "0")
  return { body, version, url: `${PRERENDERED_LIST_PATH}?v=${version}` }
}
