/**
 * @nifrajs/web — the framework-agnostic SSR core. It owns the render *seam* and the HTML
 * document orchestration, and knows nothing about any specific UI framework: a render
 * adapter (@nifrajs/web-solid, @nifrajs/web-react, …) supplies the actual render + hydrate.
 *
 * The core treats a "component" and a hydration "container" as opaque `unknown` — only
 * the adapter interprets them. That keeps this package both framework-agnostic and free
 * of DOM types: it is pure server orchestration + string building.
 */
import { type Server, server } from "@nifrajs/core"
import {
  DEFERRED_ERROR_CODE,
  DEFERRED_RUNTIME,
  type Deferred,
  defer,
  MAP_DEFERRED_SOURCE,
  ndjsonStream,
  prepareDeferred,
} from "./deferred.ts"
import { isDraftEnabled } from "./draft.ts"
import { ISR_REVALIDATE_HEADER } from "./isr.ts"
import type {
  LayoutEntry,
  LinkDescriptor,
  Manifest,
  Meta,
  MetaArgs,
  MetaInput,
  RouteEntry,
  RouteModule,
} from "./manifest.ts"
import {
  DATA_HEADER,
  PRERENDERED_GLOBAL,
  REDIRECT_HEADER,
  REVALIDATE_HEADER,
  type Submission,
} from "./router.ts"

// Draft / preview mode — a signed cookie that flips `ctx.draft` for loaders + bypasses ISR for editors.
export {
  DRAFT_COOKIE,
  type DraftCookieControls,
  disableDraft,
  type EnableDraftOptions,
  enableDraft,
  isDraftEnabled,
} from "./draft.ts"
// Font optimization — a CLS-safe `@font-face` generator + a preload `<link>` for self-hosted fonts.
export {
  type FontDisplay,
  type FontFace,
  type FontPreloadInput,
  type FontSource,
  fontFace,
  fontPreload,
} from "./fonts.ts"
// ISR (incremental static regeneration): a pluggable cache store + the `withISR` stale-while-revalidate
// wrapper for rendered SSR responses.
export {
  type CachedResponse,
  type CacheStore,
  ISR_REVALIDATE_HEADER,
  ISR_STATUS_HEADER,
  type ISRApp,
  type ISROptions,
  type ISRPlatform,
  KVCacheStore,
  type KVCacheStoreOptions,
  type KVNamespaceLike,
  MemoryCacheStore,
  type MemoryCacheStoreOptions,
  type RevalidateEndpointOptions,
  revalidateEndpoint,
  withISR,
} from "./isr.ts"

// File-based routing manifest — pure + fs-free. `discoverRoutes` (fs) lives in `@nifrajs/web/fs`.
export {
  type Action,
  buildManifest,
  enumeratePrerenderedPaths,
  enumerateStaticRoutes,
  filePathToPattern,
  filePathToPatterns,
  type GetStaticPaths,
  type LayoutEntry,
  type LinkDescriptor,
  type Loader,
  type LoaderContext,
  type Manifest,
  type Meta,
  type MetaArgs,
  type MetaInput,
  type RouteEntry,
  type RouteModule,
  type StaticPath,
  type StaticPaths,
  type StaticRoutes,
} from "./manifest.ts"
// Keyed query-cache (agnostic) — a `query(key, fn)` primitive (dedup + staleness + invalidation + GC)
// consumed by the per-adapter `useQuery`/`createQuery` bindings.
export {
  createQueryClient,
  hashQueryKey,
  type QueryClient,
  type QueryClientOptions,
  type QueryHandle,
  type QueryState,
  type QueryStatus,
} from "./query.ts"
// Agnostic client-side router core (pure + DOM-free) — consumed by per-adapter Router bindings.
// `DATA_HEADER` marks a navigation's data-only GET; `createWebApp` answers it with loader JSON.
export {
  type ClientRouter,
  type ClientRouterOptions,
  createClientRouter,
  createMatcher,
  DATA_HEADER,
  type Fetcher,
  type FetcherState,
  type FetchRouteData,
  type MountRouterOptions,
  REDIRECT_HEADER,
  REVALIDATE_HEADER,
  type RouteMatch,
  type RoutePattern,
  type RouterState,
  type Submission,
  type SubmitOptions,
} from "./router.ts"
// Deferred loader data (`defer()` + the `Deferred<T>` type) — consumed by the adapter's `<Await>`.
export { type Deferred, defer }

/** The data handed to a route component. Opaque to the core. `actionData` is the return of a
 * route `action` after a POST (absent on plain GETs). `pending` + `submission` are client-only
 * (absent on SSR): they drive **optimistic UI** — render from `submission.formData` while `pending`. */
export interface RenderProps {
  readonly data: unknown
  readonly actionData?: unknown
  /** True while a client navigation or submit is in flight (client-only; absent/false on SSR). */
  readonly pending?: boolean
  /** The in-flight client submit, for optimistic UI (client-only; absent on SSR + when idle). */
  readonly submission?: Submission
}

/** The seam every render adapter implements. */
export interface RenderAdapter {
  /**
   * Server: render a route's layout `chain` (outermost layout → page) to a **stream** of HTML
   * bytes, including the framework's hydration markers. The page (innermost) receives `props`
   * (the loader data); each layout wraps the child via its `children`. Returns (or resolves to)
   * a Web `ReadableStream<Uint8Array>`: a streaming renderer flushes the shell first and streams
   * Suspense boundaries as they resolve; a non-streaming renderer may return a one-chunk stream.
   * May be async — e.g. React resolves once the shell is renderable, so a shell-render throw can
   * still map to an error status before any byte is sent.
   */
  renderToStream(
    chain: readonly unknown[],
    props: RenderProps,
  ): ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>
  /**
   * Server (optional): render the chain to a complete HTML **string** in one pass, with the same
   * hydration markers `renderToStream` produces. When provided, `renderPage` uses it for any page
   * that does **not** `defer()` — buffering the document is faster than the streaming pipeline there,
   * because the framework's synchronous renderer (React `renderToString`, Solid `renderToString`,
   * Preact `render`, Vue `renderToString`, Svelte `render`) is markedly cheaper than its streaming
   * renderer — most visibly on Bun, where React Fizz / Solid `renderToStream` are the heaviest. Pages
   * that `defer()` keep the streaming path (progressive `<Await>` needs it). Markup MUST be
   * hydration-equivalent to `renderToStream`; a throw surfaces like the streaming shell-readiness
   * await (the `_error` boundary maps it to a status). Omit it to always stream.
   */
  renderToString?(chain: readonly unknown[], props: RenderProps): string | Promise<string>
  /**
   * Server: per-document bootstrap markup injected into `<head>` that the client
   * `hydrate` requires (Solid: `generateHydrationScript()`). Empty string if none.
   */
  hydrationHead(): string
}

/** Global the server serializes loader data into; the client reads it to hydrate. */
export const DATA_GLOBAL = "__NIFRA_DATA__"

/** Global the server writes the matched route id into; the client uses it to pick the chain. */
export const ROUTE_GLOBAL = "__NIFRA_ROUTE__"

/** Global the server serializes an action's data return into (absent on GETs); the client
 * reads it so hydration after a native form POST matches the server-rendered markup. */
export const ACTION_GLOBAL = "__NIFRA_ACTION__"

/**
 * The single default port for the dev server (`@nifrajs/web/dev`, `@nifrajs/web/vite`) **and**
 * `nifra start`. Deliberately uncommon: `3000`/`5173`/`8080` collide with whatever else is running
 * (Next, Vite, a stray Node API). `4321` rarely is — and being the *same* constant across `nifra dev`
 * and `nifra start` means a project's URL doesn't change between commands. Override per-run with
 * `--port <n>` or the `PORT` env var. */
export const DEFAULT_DEV_PORT = 4321

// Shared, stateless — allocated once at module load, not per render/stream.
const TEXT_ENCODER = new TextEncoder()

type MaybePromise<T> = T | Promise<T>

// XSS-safe `<script>` JSON escaping in a SINGLE pass: `<`/`>` would break out of the
// script element; U+2028/U+2029 are valid JSON but historically break JS string literals. Built via
// fromCharCode so no raw separator chars live in this source. One regex + one output string replaces
// the prior four sequential `replaceAll` full-string passes.
const LINE_SEP = String.fromCharCode(0x2028)
const PARA_SEP = String.fromCharCode(0x2029)
const SCRIPT_ESCAPE = new RegExp(`[<>${LINE_SEP}${PARA_SEP}]`, "g")
const SCRIPT_ESCAPE_MAP: Readonly<Record<string, string>> = {
  "<": "\\u003c",
  ">": "\\u003e",
  [LINE_SEP]: "\\u2028",
  [PARA_SEP]: "\\u2029",
}
const NODE_RESPONSE_BODY = Symbol.for("nifra.response.body")
const RESPONSE_RESULT = Symbol.for("nifra.response.result")

export interface RenderedPage {
  readonly [RESPONSE_RESULT]: true
  toResponse(): Response
  toNodeBody?(): {
    readonly status: number
    readonly headers: Readonly<Record<string, string | readonly string[]>> | undefined
    readonly body: string | Uint8Array
  }
}

export interface RenderPageOptions {
  readonly adapter: RenderAdapter
  /** The layout chain to render — outermost layout → page (opaque; the adapter renders it). */
  readonly chain: readonly unknown[]
  /** The loader output for this request. */
  readonly data: unknown
  /** An action's data return (POST only) — surfaced to the page as `actionData` + serialized
   * for the client so post-POST hydration matches. Omit on GETs. */
  readonly actionData?: unknown
  /** URL of the built client entry (loaded as a module script). */
  readonly clientEntry: string
  /** Chunk URLs for the **matched** route (its layout chain + own chunk) to `modulepreload` in the
   * shell — so the route code downloads in parallel with the entry instead of after it
   * (`buildClient`'s per-route map). Empty/omitted ⇒ only the entry is preloaded (unchanged). */
  readonly preload?: readonly string[]
  /** Stylesheet URLs for the **matched** route (its layout chain + own CSS, from `buildClient`'s
   * `BuildManifest.css`) — injected as `<link rel="stylesheet">` in `<head>` so styles arrive with the
   * first paint (no FOUC). Rendered even on non-hydrated pages. Empty/omitted ⇒ none (unchanged). */
  readonly styles?: readonly string[]
  /** SSG: the prerendered-path set, serialized to `window.__NIFRA_PRERENDERED__` so the client fetches
   * a static `_data.json` on soft-nav into a prerendered route. Empty/omitted ⇒ not injected. */
  readonly prerenderedPaths?: readonly string[]
  /** ISR: route freshness in seconds, emitted as the `x-nifra-isr-revalidate` header for a `withISR`
   * wrapper to read. Omit ⇒ no header (the wrapper's default TTL applies). */
  readonly revalidate?: number
  /** Matched route id; written to `window.__NIFRA_ROUTE__` so the client hydrates this chain. */
  readonly routeId?: string
  /** HTTP status for the response (default 200; e.g. 404 for a not-found page). */
  readonly status?: number
  /** Document title (fallback when `head.title` is unset). */
  readonly title?: string
  /** Resolved route head — `title` overrides `title` above; `meta`/`link` render as managed
   * (`data-nifra`) tags the client updates on navigation.
   *
   * **Head contract (the layout chain contributes).** `createWebApp` resolves this via
   * {@link mergeHeads}: a route's head is its **layout chain's** `meta`/`head` exports merged with the
   * page's. A `_layout.tsx` may `export const meta` (or `export function meta(args)`) — its tags land
   * on every page below it (the home for `hreflang`, `preconnect`, a section-default `<title>`). The
   * merge is **nearest-wins for scalars** (the page's `title` overrides an inner layout's, which
   * overrides an outer one; an undefined page title keeps the layout's) and **concatenated for the
   * `meta`/`link` arrays** (outermost layout first, page last). `<link>` attributes are name-validated
   * (any letter/digit/hyphen name — covers `rel`/`href`/`hreflang`/`crossorigin`/`media`/`sizes`/`as`/
   * `integrity`/`fetchpriority`/…) and value-escaped against XSS. */
  readonly head?: Meta
  /** Id of the container wrapping the app markup (default `"root"`). */
  readonly rootId?: string
  /** When `false`, emit a complete but **non-hydrated** document — no client entry script, data
   * globals, or modulepreloads. Used for server-rendered `_error` pages: a terminal state that needs no
   * client takeover, and it sidesteps an SSR/hydrate mismatch (the server rendered the boundary, not
   * the page the client manifest maps this route id to). Default `true`. */
  readonly hydrate?: boolean
  /** Island client bundles (`@nifrajs/web/islands`) to load as `<script type="module">` in the document
   * tail — emitted **regardless of `hydrate`**, so a static (`hydrate: false`) page can still mount
   * no-framework islands. URLs are attribute-escaped. Empty/omitted ⇒ none (unchanged output). */
  readonly islandScripts?: readonly string[]
}

/**
 * Server: render a full HTML document for a page — the adapter's hydration head + the SSR
 * markup (**streamed**) + the serialized loader data + the client module — as a `Response`.
 * The shell (`<head>` + the open container) flushes first, the adapter's app stream follows,
 * then the tail (data globals + client entry). Pure Web Standards, so it returns straight from
 * a nifra route handler and streams on any fetch runtime (Bun/Node/Deno/Workers).
 */
export function renderPage(options: RenderPageOptions): MaybePromise<Response> {
  const page = renderPageResult(options)
  return page instanceof Promise ? page.then((p) => p.toResponse()) : page.toResponse()
}

export function renderPageResult(options: RenderPageOptions): MaybePromise<RenderedPage> {
  const {
    adapter,
    chain,
    data,
    actionData,
    clientEntry,
    preload = [],
    styles = [],
    prerenderedPaths = [],
    revalidate,
    routeId,
    status = 200,
    title = "nifra",
    head,
    rootId = "root",
    hydrate = true,
    islandScripts = [],
  } = options
  const route = routeId === undefined ? "" : `window.${ROUTE_GLOBAL}=${serializeData(routeId)};`
  // The SSG prerendered-path set (when an app declares it) — the client reads it to fetch a static
  // `_data.json` on soft-nav into a prerendered route instead of hitting the worker. Empty ⇒ omitted.
  const prerendered =
    prerenderedPaths.length === 0
      ? ""
      : `window.${PRERENDERED_GLOBAL}=${serializeData(prerenderedPaths)};`
  // Split deferred values: the component sees markers (id + promise) to `<Await>`; the serialized
  // data carries `{__nifra_deferred: id}` placeholders (promises don't serialize). `actionData` may
  // also `defer()` — split it too, continuing the id space so a single registry settles both. The
  // inline registry runtime is emitted only when something defers, so non-deferred output is unchanged.
  const { forComponent, forClient, deferred } = prepareDeferred(data)
  const actionSplit =
    actionData === undefined ? undefined : prepareDeferred(actionData, deferred.length)
  const allDeferred = actionSplit ? [...deferred, ...actionSplit.deferred] : deferred
  // Only emit the action global when an action actually ran, so plain GET output is unchanged.
  const action =
    actionSplit === undefined
      ? ""
      : `window.${ACTION_GLOBAL}=${serializeData(actionSplit.forClient)};`
  const deferredRuntime = allDeferred.length > 0 ? `<script>${DEFERRED_RUNTIME}</script>` : ""
  // Matched-route chunk preloads, concatenated directly (skip the `filter().map()`
  // intermediate arrays — and the whole loop — on the common no-extra-preload render). De-duped
  // against the entry, which is preloaded separately below.
  let preloadLinks = ""
  if (preload.length > 0) {
    for (const url of preload) {
      if (url !== clientEntry)
        preloadLinks += `<link rel="modulepreload" href="${escapeAttr(url)}">`
    }
  }
  // The matched route's stylesheets — `<link rel="stylesheet">` in `<head>` so CSS arrives with the
  // first paint (no FOUC). Render-blocking by design, and emitted regardless of `hydrate` (a static or
  // `_error` page still wants its styles). In dev (Vite) CSS is injected client-side instead, so
  // `styles` is empty there.
  let styleLinks = ""
  for (const url of styles) styleLinks += `<link rel="stylesheet" href="${escapeAttr(url)}">`
  // Island bundles are referenced only by a `<script type="module">` at the END of `<body>` (below), so
  // the browser doesn't discover them until the whole page is parsed. `modulepreload` them in `<head>`
  // so the fetch starts immediately, in parallel with parsing — regardless of `hydrate` (an island page
  // is typically hydrate:false). Without this, a heavy island bundle on a cold first load leaves its
  // server-rendered placeholder visible until that late, un-prefetched fetch lands ("stuck loading").
  let islandPreloads = ""
  for (const src of islandScripts)
    islandPreloads += `<link rel="modulepreload" href="${escapeAttr(src)}">`
  // Shell — flushed before the app finishes rendering: `<head>` (title, meta, hydration head) + the
  // open container. `modulepreload` of the client entry — plus the matched route's own chunks
  // (`preloadLinks`) — lets the JS download while the body streams. One template literal (no
  // intermediate array + `join`) — byte-identical to the prior output.
  // A non-hydrated page (e.g. an `_error` boundary) omits the client-entry preload, route-chunk
  // preloads, and deferred runtime — there's no client takeover to feed.
  const hydrationLinks = hydrate
    ? `<link rel="modulepreload" href="${escapeAttr(clientEntry)}">${preloadLinks}${deferredRuntime}`
    : ""
  const shellHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(head?.title ?? title)}</title>${headTags(head)}${styleLinks}${hydrationLinks}${islandPreloads}${adapter.hydrationHead()}</head><body><div id="${escapeAttr(rootId)}">`
  // Closes the hydration container; deferred resolve scripts go AFTER it (outside `#root`) so they
  // aren't part of the adapter's hydrated tree (an inline script inside it breaks hydration).
  const closeRootHtml = "</div>"
  // Tail — the loader-data globals + the client module. Module scripts defer (run after parse), so
  // the data global + every streamed deferred resolution are set before the entry hydrates.
  // Island bundles load regardless of `hydrate` — a static page (hydrate:false) ships no framework
  // client but can still mount no-framework islands (`@nifrajs/web/islands`).
  let islandTags = ""
  for (const src of islandScripts)
    islandTags += `<script type="module" src="${escapeAttr(src)}"></script>`
  const tailHtml = `${
    hydrate
      ? `<script>${route}${action}${prerendered}window.${DATA_GLOBAL}=${serializeData(forClient)}</script><script type="module" src="${escapeAttr(clientEntry)}"></script>`
      : ""
  }${islandTags}</body></html>`
  const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" }
  // ISR: advertise the route's freshness so a `withISR` wrapper can set this page's cache TTL. A
  // dedicated header (not the action-revalidation `x-nifra-revalidate`) so the TTL channel never aliases
  // the client's path-list channel.
  if (revalidate !== undefined) headers[ISR_REVALIDATE_HEADER] = String(revalidate)
  const renderProps: RenderProps = { data: forComponent, actionData: actionSplit?.forComponent }

  // Fast path: nothing `defer()`s and the adapter can render synchronously to a string → buffer the
  // whole document in one pass. Progressive streaming only benefits pages with deferred boundaries
  // (those take the streaming path below); for a plain page the streaming pipeline + the framework's
  // streaming renderer are pure overhead vs a single sync render + concat. A buffered string body also
  // gets an automatic Content-Length. A render throw surfaces here exactly as the streaming path's
  // shell-readiness `await` does, so the `_error` boundary still maps it to a status.
  if (allDeferred.length === 0 && adapter.renderToString !== undefined) {
    const out = adapter.renderToString(chain, renderProps)
    return typeof out === "string"
      ? new BufferedRenderedPage(shellHtml + out + closeRootHtml + tailHtml, status, headers)
      : out.then(
          (bodyHtml) =>
            new BufferedRenderedPage(
              shellHtml + bodyHtml + closeRootHtml + tailHtml,
              status,
              headers,
            ),
        )
  }

  return renderStreamedPage(
    adapter,
    chain,
    renderProps,
    shellHtml,
    closeRootHtml,
    allDeferred,
    tailHtml,
    status,
    headers,
  ).then((response) => new ResponseRenderedPage(response))
}

async function renderStreamedPage(
  adapter: RenderAdapter,
  chain: readonly unknown[],
  renderProps: RenderProps,
  shellHtml: string,
  closeRootHtml: string,
  allDeferred: ReadonlyArray<{ readonly id: number; readonly promise: Promise<unknown> }>,
  tailHtml: string,
  status: number,
  headers: Record<string, string>,
): Promise<Response> {
  // Streaming path — required for `defer()` (progressive `<Await>` resolution) and used by any adapter
  // that doesn't implement `renderToString`. Awaiting `renderToStream` resolves on shell-readiness
  // (React: on-shell-ready; Solid: synchronously), so a shell-render throw surfaces before any byte is
  // sent. A *mid*-stream failure errors the body instead.
  const enc = TEXT_ENCODER
  const shell = enc.encode(shellHtml)
  const closeRoot = enc.encode(closeRootHtml)
  const tail = enc.encode(tailHtml)
  const appStream = await adapter.renderToStream(chain, renderProps)
  const body = streamDocument(shell, appStream, closeRoot, allDeferred, tail, enc)
  return new Response(body, { status, headers })
}

class BufferedRenderedPage implements RenderedPage {
  readonly [RESPONSE_RESULT] = true
  private readonly body: string
  private readonly status: number
  private readonly headers: Readonly<Record<string, string>>

  constructor(body: string, status: number, headers: Readonly<Record<string, string>>) {
    this.body = body
    this.status = status
    this.headers = headers
  }

  toResponse(): Response {
    return htmlResponse(this.body, { status: this.status, headers: this.headers })
  }

  toNodeBody(): {
    readonly status: number
    readonly headers: Readonly<Record<string, string | readonly string[]>>
    readonly body: string
  } {
    return { status: this.status, headers: this.headers, body: this.body }
  }
}

class ResponseRenderedPage implements RenderedPage {
  readonly [RESPONSE_RESULT] = true
  private readonly response: Response

  constructor(response: Response) {
    this.response = response
  }

  toResponse(): Response {
    return this.response
  }
}

function htmlResponse(body: string, init: ResponseInit): Response {
  const response = new Response(body, init)
  // @nifrajs/node can write buffered HTML straight to ServerResponse with `end(body)`, avoiding a Web
  // Response stream drain on Node. Non-enumerable + Symbol.for keeps this invisible to Web runtimes and
  // cross-package without adding a runtime dependency from @nifrajs/node to @nifrajs/web.
  Object.defineProperty(response, NODE_RESPONSE_BODY, { value: body })
  return response
}

/**
 * Assemble the document stream: `shell` → the app `stream` (forwarded chunk-by-chunk, so a streaming
 * renderer's progressive flushing is preserved) → `closeRoot` → one `__nifraResolve`/`__nifraReject`
 * script per deferred value (emitted once its promise settles — by now the app stream has awaited
 * the same Suspense boundaries — and placed OUTSIDE `#root`) → `tail`. A mid-stream app error errors
 * the result (the body breaks) rather than silently truncating a 200.
 */
function streamDocument(
  shell: Uint8Array,
  stream: ReadableStream<Uint8Array>,
  closeRoot: Uint8Array,
  deferred: ReadonlyArray<{ readonly id: number; readonly promise: Promise<unknown> }>,
  tail: Uint8Array,
  enc: TextEncoder,
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      const reader = stream.getReader()
      try {
        controller.enqueue(shell)
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          controller.enqueue(value)
        }
        controller.enqueue(closeRoot)
        // Stream each resolution as ITS OWN promise settles — NOT in array order. A slow
        // defer() must not block a faster one; each script self-addresses by id, so order is irrelevant.
        await Promise.all(
          deferred.map(async (d) => {
            try {
              const value = serializeData(await d.promise)
              controller.enqueue(
                enc.encode(`<script>window.__nifraResolve(${d.id},${value})</script>`),
              )
            } catch (err) {
              // A rejected deferred streams __nifraReject (the client `<Await>` surfaces it) — it must
              // not break the whole body. Redact: stream a stable opaque code, never the raw error
              // text; log the real reason server-side.
              console.error("[nifra/web] deferred value rejected:", err)
              controller.enqueue(
                enc.encode(
                  `<script>window.__nifraReject(${d.id},${serializeData(DEFERRED_ERROR_CODE)})</script>`,
                ),
              )
            }
          }),
        )
        controller.enqueue(tail)
        controller.close()
      } catch (err) {
        controller.error(err)
      } finally {
        reader.releaseLock()
      }
    },
  })
}

/** Options for {@link redirect}. */
export interface RedirectOptions {
  /** HTTP status (default 303 See Other; pass 307/308 to preserve the method). */
  readonly status?: number
  /** Allow an off-origin / absolute destination. Off by default: only a same-origin path (a single
   * leading `/`) is permitted, so an action can't be turned into an open redirect by passing
   * attacker-controlled input straight through. Set `true` for a deliberate external redirect. */
  readonly external?: boolean
}

/** A same-origin destination is an absolute path: one leading `/`, but NOT `//` (protocol-relative →
 * another origin). Everything else (absolute URL with a scheme, `//host`, `javascript:`, a bare
 * relative `foo`) is treated as off-origin and requires `external: true`. */
function isSameOriginPath(location: string): boolean {
  return location.startsWith("/") && !location.startsWith("//")
}

/**
 * Build a redirect `Response` — return it from a route `action` for the Post/Redirect/Get
 * pattern (POST mutates, 303 sends the browser to a fresh GET, so a reload doesn't re-submit).
 * Defaults to 303 (See Other); pass `307`/`308` (or `{ status }`) to preserve the method.
 *
 * **Secure by default:** `location` must be a same-origin path (begins with `/`, not `//`). An
 * off-origin/absolute destination throws unless you pass `{ external: true }` — this closes the
 * open-redirect footgun of `return redirect(formData.get("next"))` on the no-JS (native-form) path,
 * which returns the action's `Response` verbatim.
 *
 * @param statusOrOptions a status number (back-compat) or `{ status?, external? }`.
 */
export function redirect(
  location: string,
  statusOrOptions: number | RedirectOptions = 303,
): Response {
  const opts = typeof statusOrOptions === "number" ? { status: statusOrOptions } : statusOrOptions
  if (opts.external !== true && !isSameOriginPath(location)) {
    throw new Error(
      `[nifra/web] redirect(${JSON.stringify(location)}) is not a same-origin path. Use a path beginning with "/" (not "//"), or redirect(location, { external: true }) for a deliberate off-origin redirect. This guards against open redirects from unvalidated input.`,
    )
  }
  // Reject CR/LF in the Location explicitly — defense-in-depth (response splitting / header
  // injection). Spec-correct runtimes' Headers setter throws on CR/LF, but `external: true` lets
  // unvalidated input reach this sink, so we don't rely on the runtime. Same posture as
  // serializeCookie / the SSE frame formatter, which strip CRLF at their sinks.
  if (/[\r\n]/.test(location)) {
    throw new Error(
      `[nifra/web] redirect location contains a CR/LF character — refusing to emit a header-injecting redirect.`,
    )
  }
  return new Response(null, { status: opts.status ?? 303, headers: { location } })
}

/** The wrapper `revalidate()` returns: the action's `data` plus the paths it changed. A plain tagged
 * shape (not a class) so `@nifrajs/client`'s `ActionData` can unwrap it structurally without importing
 * from `@nifrajs/web`. `createWebApp` strips the wrapper — the client receives `data` as the body and
 * the paths via the `X-Nifra-Revalidate` header. */
export interface RevalidateResult<T> {
  readonly __nifraRevalidate: readonly string[]
  readonly data: T
}

/**
 * Return this from an action to declare which routes the mutation changed (alongside the action's
 * `data`). `createWebApp` sets the `X-Nifra-Revalidate` response header; after the submit the client
 * marks those cached routes stale — refetching the active one and any mounted fetcher showing them —
 * so a mutation can refresh views beyond the one that was submitted. `data` is still surfaced to the
 * component as `actionData` (the wrapper is transparent to `ActionData<typeof action>`).
 */
export function revalidate<T>(paths: readonly string[], data: T): RevalidateResult<T> {
  return { __nifraRevalidate: paths, data }
}

/**
 * Serialize loader data for embedding inside an inline `<script>`. `JSON.stringify` alone
 * is NOT safe there: a string containing `</script>` or `<!--` would break out of the
 * script element (an XSS vector). Escape `<`/`>` to `\uXXXX`, plus the U+2028/U+2029
 * separators.
 */
export function serializeData(data: unknown): string {
  return JSON.stringify(data ?? null).replace(SCRIPT_ESCAPE, (ch) => SCRIPT_ESCAPE_MAP[ch] ?? ch)
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

function escapeAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}

// Attribute-NAME guard for emitted `<meta>`/`<link>` tags. Intentionally a *name-shape* allowlist, not
// a hardcoded per-attribute one: any letter/digit/hyphen name beginning with a letter is permitted, so
// every standard `<link>` attribute flows through — `rel`, `href`, `hreflang`, `crossorigin`, `media`,
// `sizes`, `type`, `as`, `title`, `integrity`, `referrerpolicy`, `imagesrcset`, `imagesizes`,
// `disabled`, `color`, `fetchpriority` — alongside `<meta>`'s `name`/`property`/`content` and custom
// `data-*`. A hardcoded list would silently drop valid attrs (the bug this guards against: `hreflang`
// /`crossorigin` getting filtered out). What it rejects is name-shape abuse only — a name with a space,
// `=`, `>`, quote, or a leading digit can't break out of the tag. Attribute VALUES are escaped
// separately (they may carry loader data → XSS), so a widened name set never widens the injection
// surface. Names that fail the shape check are dropped.
const SAFE_ATTR_NAME = /^[a-zA-Z][a-zA-Z0-9-]*$/

/** Serialize a meta/link tag's attributes: validate the name shape (see {@link SAFE_ATTR_NAME}) +
 * escape the value against XSS. Invalid attribute names are dropped. Values follow the HTML attribute
 * conventions {@link LinkDescriptor} types: a string renders `name="escaped"`; `true` renders the bare
 * boolean attribute (`disabled`); `false` and `undefined` are skipped (a conditionally-absent attr). */
function tagAttrs(attrs: Record<string, string | boolean | undefined>): string {
  let out = ""
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue // omitted / absent boolean attribute
    if (!SAFE_ATTR_NAME.test(name)) continue // name-shape abuse — dropped (see SAFE_ATTR_NAME)
    if (out !== "") out += " "
    out += value === true ? name : `${name}="${escapeAttr(value)}"`
  }
  return out
}

// Memoize the serialized head-tag string by the resolved `Meta` object's identity. A STATIC route
// `meta` is returned by-reference from resolveMeta, so the same object recurs every request → cache
// hit, and the invariant string is serialized once per route, not per request. A FUNCTION `meta`
// builds a fresh object each request (new identity) → miss → recompute, exactly as needed (its
// content can vary). WeakMap so a route module that's GC'd takes its entry with it.
const headTagsCache = new WeakMap<Meta, string>()

/** Render a route's `meta`/`link` as managed (`data-nifra`) head tags. Title is set separately.
 * String concatenation (no intermediate `.map()` arrays + spread) — parity with the already
 * concat-based preloadLinks/styleLinks/islandPreloads loops; byte-identical output.
 * Result is memoized per resolved-`Meta` identity (static meta → serialized once per route). */
function headTags(head: Meta | undefined): string {
  if (head === undefined) return ""
  const cached = headTagsCache.get(head)
  if (cached !== undefined) return cached
  let out = ""
  if (head.meta !== undefined) for (const m of head.meta) out += `<meta ${tagAttrs(m)} data-nifra>`
  if (head.link !== undefined) for (const l of head.link) out += `<link ${tagAttrs(l)} data-nifra>`
  headTagsCache.set(head, out)
  return out
}

/** Resolve a route's `meta` (static or a function of the loader data + params) to a {@link Meta}. */
export function resolveMeta(meta: MetaInput | undefined, args: MetaArgs): Meta {
  if (meta === undefined) return {}
  return typeof meta === "function" ? meta(args) : meta
}

/**
 * Merge a route's `<head>` contributions from its layout chain + the page into one {@link Meta}.
 *
 * The head contract (see {@link CreateWebAppOptions} and `LayoutEntry`): a `_layout.tsx` may export
 * `meta` to put sitewide tags (`hreflang`, `preconnect`, a default `<title>`, …) on every page below
 * it. `heads` is passed **outermost layout → … → innermost layout → page** (the same order as the
 * render chain), and merges:
 *  - **`title`** — *nearest-wins*: the last defined value across the list, so the page overrides an
 *    inner layout, which overrides an outer one. A layout `title` is the section default; an undefined
 *    page `title` keeps it.
 *  - **`meta` / `link`** — *concatenated* in list order (outermost first, page last). Duplicate-tag
 *    de-duplication is the caller's concern; the framework emits exactly what's declared so a layout
 *    can ship N `<link rel="alternate" hreflang>` tags and a page can add its own canonical.
 *
 * Returns a fresh object whose identity is stable per `heads` *content* only when every entry is a
 * static (by-reference) `Meta` and there is exactly one — otherwise a new object each call. That is
 * fine: {@link headTags}'s memo is keyed on identity, so a per-request merge simply recomputes (its
 * content can vary with loader data anyway).
 */
export function mergeHeads(heads: readonly Meta[]): Meta {
  // Single-head fast path (a route with no layout `meta`, by far the common case) — return the
  // resolved object by reference so headTags' identity-keyed memo hits across requests for static meta.
  if (heads.length === 1) return heads[0] as Meta
  let title: string | undefined
  const meta: Array<Record<string, string>> = []
  const link: LinkDescriptor[] = []
  for (const h of heads) {
    if (h.title !== undefined) title = h.title // nearest-wins: later (more specific) overrides
    if (h.meta !== undefined) meta.push(...h.meta)
    if (h.link !== undefined) link.push(...h.link)
  }
  // Build the result with only the fields that were actually contributed — an empty `meta`/`link`
  // array would otherwise be a spurious (if harmless) key. A mutable local; the cast to `Meta` is sound
  // because a key is assigned only when defined (so `exactOptionalPropertyTypes` never sees `undefined`).
  const merged: { title?: string; meta?: Meta["meta"]; link?: Meta["link"] } = {}
  if (title !== undefined) merged.title = title
  if (meta.length > 0) merged.meta = meta
  if (link.length > 0) merged.link = link
  return merged as Meta
}

export interface CreateWebAppOptions {
  readonly adapter: RenderAdapter
  readonly manifest: Manifest
  /** URL of the built client entry (module script) injected into every page. */
  readonly clientEntry: string
  /** Default document title for all pages. */
  readonly title?: string
  /** Injected into each loader's `ctx.api` — typically an `inProcessClient(app)` (typed
   * per-route via `@nifrajs/client`'s `createRoutes`). Opaque to the core. */
  readonly api?: unknown
  /** Secret for **draft / preview mode** (see `enableDraft`). When set, a request carrying a valid
   * signed `__nifra_draft` cookie gets `ctx.draft === true` in loaders/actions (else always `false`).
   * Pair with `withISR({ draftSecret })` so editors bypass the cache. Omit to disable draft mode. */
  readonly draftSecret?: string
  /** Per-route chunk URLs (`buildClient`'s `BuildManifest.routes`) — `routeId → [layout chunks…, own
   * chunk]`. When present, each page `modulepreload`s its matched route's chunks alongside the entry,
   * so the route code downloads in parallel (no entry→route-chunk waterfall). Omit ⇒ entry-only. */
  readonly routePreload?: Readonly<Record<string, readonly string[]>>
  /** The app's bundled stylesheet URLs (`buildClient`'s `BuildManifest.css`) — the aggregate, injected
   * as `<link rel="stylesheet">` in a page's `<head>`. Used as the fallback for any route absent from
   * {@link routeStyles}. Omit ⇒ no links (dev, where Vite injects CSS, or a CSS-free app). */
  readonly styles?: readonly string[]
  /** Per-route stylesheet URLs (`buildClient`'s `BuildManifest.routeStyles`) — `routeId → [chain CSS]`.
   * When a matched route has an entry here, only those (its layout chain + own CSS) are linked instead
   * of the aggregate `styles`, so a page ships only the CSS it uses. An empty array ⇒ no `<link>` (the
   * page imports no CSS). Routes absent here fall back to `styles`. Omit ⇒ always use `styles`. */
  readonly routeStyles?: Readonly<Record<string, readonly string[]>>
  /** SSG: the prerendered-path set (e.g. from `enumeratePrerenderedPaths` or the build's
   * `prerendered.json`). Injected as `window.__NIFRA_PRERENDERED__` on every page so a client soft-nav
   * into a prerendered route fetches its static `_data.json` instead of hitting the worker. */
  readonly prerenderedPaths?: readonly string[]
  /** SSG: per dynamic route pattern, its `getStaticPaths` `fallback` (from `enumerateStaticRoutes` or
   * the build's `prerendered.json`). A route mapped to `"404"` rejects any path NOT in
   * `prerenderedPaths` with the 404 page — the unlisted path simply doesn't exist. `"ssr"` (the
   * default for unmapped routes) renders unlisted paths on-demand. */
  readonly staticFallbacks?: Readonly<Record<string, "ssr" | "404">>
  /** Observe every loader/action failure — for error-reporting plugins (Sentry-style). Called for
   * real throws (not control-flow `Response`s like `redirect`), **before** the nearest `_error`
   * boundary renders / a soft-nav 500 / a rethrow — so it sees errors that the boundary would
   * otherwise hide. Observation only; its own throws are swallowed so a faulty reporter can't break
   * rendering. (`beforeLoader` is intentionally omitted — the core HTTP hooks already cover
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

/** The handler context fields createWebApp uses — a structural subset of nifra's `Context`. */
interface RouteContext {
  readonly params: Record<string, string>
  readonly req: Request
  /** Platform bindings (Workers env), forwarded to each route's loader/action as `args.env`. */
  readonly env: unknown
}

/**
 * Build a nifra app from a route manifest: every route SSRs its layout chain via `renderPage`,
 * and a wildcard catch-all renders `_404` (or a plain 404). Reuses @nifrajs/core's router +
 * lifecycle, so matching, params, and precedence are battle-tested. fs-free — feed it a
 * manifest from `discoverRoutes` (`@nifrajs/web/fs`) at startup, so the served app stays portable.
 */
export function createWebApp(options: CreateWebAppOptions): Server {
  const { adapter, manifest, clientEntry, title, api } = options
  const titleOption = title === undefined ? {} : { title }
  // Draft/preview: when a `draftSecret` is configured, each request's signed `__nifra_draft` cookie is
  // verified once and surfaced to loaders/actions as `ctx.draft`. No secret ⇒ always `false` (sync, free).
  const draftFlag = (req: Request): Promise<boolean> =>
    options.draftSecret === undefined
      ? Promise.resolve(false)
      : isDraftEnabled(req, options.draftSecret)
  // Per-route preload chunks (spread into renderPage; omitted when unmapped, for exactOptionalPropertyTypes).
  const preloadOf = (id: string): { preload?: readonly string[] } => {
    const chunks = options.routePreload?.[id]
    return chunks ? { preload: chunks } : {}
  }
  // The matched route's stylesheet links (spread into renderPage). Per-route when the build mapped it
  // (`routeStyles[id]` — only the chain's CSS; an empty array ⇒ no `<link>`), else the aggregate
  // `styles`. Omitted entirely when CSS-free (for exactOptionalPropertyTypes).
  const stylesOf = (id: string): { styles?: readonly string[] } => {
    const perRoute = options.routeStyles?.[id]
    if (perRoute !== undefined) return { styles: perRoute }
    return options.styles && options.styles.length > 0 ? { styles: options.styles } : {}
  }
  const app = server()
  // SSG `fallback: "404"`: the set of concrete paths that actually exist for those routes. An unlisted
  // path under a `"404"` route is rejected (it isn't a static file, and the route declared it shouldn't
  // SSR on demand). O(1) membership via a Set.
  const prerenderedSet = new Set(options.prerenderedPaths ?? [])

  // Load a route's layout modules (outermost layout → innermost), keeping each module whole so the
  // render path can take both its `default` (the component chain) AND its `meta` (the sitewide head it
  // contributes). Loaded lazily — the data-only and 405 branches return before any layout is needed.
  const loadLayoutModules = (
    route: RouteEntry,
  ): Promise<ReadonlyArray<{ default: unknown; meta?: MetaInput }>> =>
    Promise.all(
      // layoutIds only reference layouts present in the manifest (buildManifest invariant).
      route.layoutIds.map((id) => (manifest.layouts[id] as LayoutEntry).load()),
    )

  // Build a route's render chain + its merged `<head>` from the already-loaded layout modules + the
  // page module. The chain is `[…layout components, page]`; the head merges each layout's `meta`
  // export (outermost→innermost) with the page's (last), so a `head`/`meta` on `_layout.tsx`
  // contributes sitewide tags. `metaArgs` (loader data + params) feed function-form `meta`s.
  const resolveChainAndHead = (
    layoutModules: ReadonlyArray<{ default: unknown; meta?: MetaInput }>,
    page: RouteModule,
    metaArgs: MetaArgs,
  ): { chain: unknown[]; head: Meta } => {
    const chain = [...layoutModules.map((m) => m.default), page.default]
    const heads = [
      ...layoutModules.map((m) => resolveMeta(m.meta, metaArgs)),
      resolveMeta(page.meta, metaArgs),
    ]
    return { chain, head: mergeHeads(heads) }
  }

  // Dir a special-file id lives in: `_error`→"" , `a/b/_error`→"a/b" (and likewise for `_layout`).
  const dirOfId = (id: string, suffix: string): string =>
    id === suffix ? "" : id.slice(0, id.length - suffix.length - 1)

  /**
   * Render the **nearest `_error` boundary** when a route's loader throws (the agnostic, server-side
   * half of error UI — works on every adapter, no client takeover). The boundary renders in place of
   * the page, wrapped by the layouts **at or above** its segment (deeper layouts are dropped). It's
   * served **non-hydrated** at status 500: a terminal page, and rendering a boundary (not the page the
   * client maps this route to) would otherwise hydrate-mismatch. The component receives `{ name,
   * message }` — never the stack (no internals leak into HTML).
   */
  const renderError = async (
    route: RouteEntry,
    errorId: string,
    err: unknown,
  ): Promise<Response | RenderedPage> => {
    const errDir = dirOfId(errorId, "_error")
    const keptLayoutIds = route.layoutIds.filter((id) => {
      const ld = dirOfId(id, "_layout")
      return ld === "" || ld === errDir || errDir.startsWith(`${ld}/`)
    })
    const layouts = await Promise.all(
      keptLayoutIds.map((id) =>
        (manifest.layouts[id] as LayoutEntry).load().then((m) => m.default),
      ),
    )
    const { default: errComp } = await (manifest.errors?.[errorId] as LayoutEntry).load()
    const e = err instanceof Error ? err : new Error(String(err))
    return renderPageResult({
      adapter,
      chain: [...layouts, errComp],
      data: { name: e.name, message: e.message },
      clientEntry,
      routeId: errorId,
      status: 500,
      hydrate: false,
      ...titleOption,
    })
  }

  // The 404 response — the `_404` page (status 404) or a plain-text fallback. Shared by the wildcard
  // catch-all (unmatched paths) and the `fallback: "404"` enforcement (unlisted paths under a route
  // that opted out of on-demand SSR).
  const renderNotFound = async (): Promise<Response | RenderedPage> => {
    if (manifest.notFound === undefined) {
      return new Response("Not Found", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      })
    }
    const { default: notFound } = await manifest.notFound.load()
    return renderPageResult({
      adapter,
      chain: [notFound],
      data: null,
      clientEntry,
      routeId: "_404",
      status: 404,
      ...preloadOf("_404"),
      ...stylesOf("_404"),
      prerenderedPaths: options.prerenderedPaths ?? [],
      ...titleOption,
    })
  }

  for (const route of manifest.routes) {
    // A dynamic route whose `getStaticPaths` declared `fallback: "404"` — only its prerendered paths
    // exist; anything else 404s (computed once per route, not per request).
    const is404Fallback = options.staticFallbacks?.[route.pattern] === "404"
    app.register("GET", route.pattern, undefined, async (c: RouteContext) => {
      // Enforce `fallback: "404"` before any work: an unlisted path under this route doesn't exist.
      // Covers hard navigation directly; a client soft-nav's data fetch gets the 404, throws, and the
      // history layer falls back to a full-page navigation (which lands here again, as a document).
      if (is404Fallback && !prerenderedSet.has(new URL(c.req.url).pathname)) {
        return renderNotFound()
      }
      const mod = await route.load()
      const draft = await draftFlag(c.req)
      let data: unknown
      try {
        data = mod.loader
          ? await mod.loader({ params: c.params, request: c.req, api, env: c.env, draft })
          : null
      } catch (err) {
        // A thrown `Response` is a control-flow signal (a guard's `redirect(...)`, an explicit error
        // response) — let it propagate to core, which returns it as-is. Real errors render the nearest
        // `_error` boundary, if any; with none, rethrow (unchanged 500 behavior).
        if (err instanceof Response) throw err
        // Let reporting plugins observe the data-layer failure before it's rendered/rethrown/500'd.
        if (options.onLoaderError !== undefined) {
          try {
            options.onLoaderError(err, { request: c.req, params: c.params, route: route.pattern })
          } catch {
            // A faulty reporter must never break error rendering.
          }
        }
        const errorId = route.errorIds?.at(-1)
        if (errorId === undefined) throw err
        // A soft-nav data fetch can't render a boundary — 500 so the client falls back to a full-page
        // navigation, which lands here as a document and renders the `_error` page.
        if (c.req.headers.get(DATA_HEADER) !== null) {
          return new Response("Internal Server Error", {
            status: 500,
            headers: { "content-type": "text/plain; charset=utf-8" },
          })
        }
        return renderError(route, errorId, err)
      }
      // Client-side navigation asks (via the X-Nifra-Data header) for just the loader data — no full
      // document, no layout chain. A route with deferred data streams NDJSON (critical data first,
      // then each deferred value as it settles); otherwise one JSON (the fast path). Same loader,
      // same auth — only the transport differs.
      if (c.req.headers.get(DATA_HEADER) !== null) {
        const { forClient, deferred } = prepareDeferred(data)
        if (deferred.length === 0) return Response.json(data ?? null)
        return new Response(ndjsonStream(forClient, deferred), {
          headers: { "content-type": "application/x-ndjson; charset=utf-8" },
        })
      }
      const { chain, head } = resolveChainAndHead(await loadLayoutModules(route), mod, {
        data,
        params: c.params,
      })
      const hydrateRoute = mod.hydrate !== false
      try {
        // `await` so a shell-render throw (renderToStream rejects before any byte) is caught here and
        // can render the `_error` page — not just a loader throw. Mid-stream (post-shell) throws can't
        // be recovered to a full page; the per-adapter client boundary catches client render errors.
        return await renderPageResult({
          adapter,
          chain,
          data,
          head,
          clientEntry,
          routeId: route.id,
          hydrate: hydrateRoute,
          ...preloadOf(route.id),
          ...stylesOf(route.id),
          prerenderedPaths: options.prerenderedPaths ?? [],
          ...(mod.revalidate !== undefined ? { revalidate: mod.revalidate } : {}),
          ...(mod.islandScripts !== undefined ? { islandScripts: mod.islandScripts } : {}),
          ...titleOption,
        })
      } catch (err) {
        if (err instanceof Response) throw err
        // Let reporting plugins observe the data-layer failure before it's rendered/rethrown/500'd.
        if (options.onLoaderError !== undefined) {
          try {
            options.onLoaderError(err, { request: c.req, params: c.params, route: route.pattern })
          } catch {
            // A faulty reporter must never break error rendering.
          }
        }
        const errorId = route.errorIds?.at(-1)
        if (errorId === undefined) throw err
        return renderError(route, errorId, err)
      }
    })

    // POST runs the route's `action` (mutation). A `Response` return (e.g. a `redirect(...)`)
    // passes straight through; a data return re-renders the page (the loader re-runs for fresh
    // data) with `actionData`. Routes without an action reject POST with 405 — not a stray 404.
    app.register("POST", route.pattern, undefined, async (c: RouteContext) => {
      const mod = await route.load()
      const draft = await draftFlag(c.req)
      if (mod.action === undefined) {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { allow: "GET", "content-type": "text/plain; charset=utf-8" },
        })
      }
      const result = await mod.action({ params: c.params, request: c.req, api, env: c.env, draft })
      const isDataRequest = c.req.headers.get(DATA_HEADER) !== null
      // An action may wrap its data in `revalidate(paths, data)` to declare which routes it changed.
      // Unwrap to the inner data; the paths ride the `X-Nifra-Revalidate` header on the data-mode
      // responses (the client acts on them — a full-page POST re-runs loaders inline, so no header).
      const isRevalidate =
        result !== null && typeof result === "object" && "__nifraRevalidate" in result
      const actionResult = isRevalidate ? (result as RevalidateResult<unknown>).data : result
      const revalidateHeader: Record<string, string> = isRevalidate
        ? { [REVALIDATE_HEADER]: (result as RevalidateResult<unknown>).__nifraRevalidate.join(",") }
        : {}
      if (actionResult instanceof Response) {
        // Client submit can't read a 3xx Location (fetch follows it to HTML), so convey the
        // redirect via a header on a 204 and let the client navigate. Native forms get the 3xx.
        if (isDataRequest && actionResult.status >= 300 && actionResult.status < 400) {
          const location = actionResult.headers.get("location") ?? "/"
          return new Response(null, { status: 204, headers: { [REDIRECT_HEADER]: location } })
        }
        return actionResult
      }
      // Client submit wants just the action's data (it revalidates the loader itself); a native
      // form POST re-renders the full page (loader re-runs) with the action data.
      if (isDataRequest) {
        // An action may `defer()` slow parts of its result — stream them (critical data first, then
        // each deferred as it settles) exactly like a loader; a non-deferred action returns one JSON.
        const { forClient, deferred } = prepareDeferred(actionResult)
        if (deferred.length === 0)
          return Response.json(actionResult ?? null, { headers: revalidateHeader })
        return new Response(ndjsonStream(forClient, deferred), {
          headers: { "content-type": "application/x-ndjson; charset=utf-8", ...revalidateHeader },
        })
      }
      const data = mod.loader
        ? await mod.loader({ params: c.params, request: c.req, api, env: c.env, draft })
        : null
      const { chain, head } = resolveChainAndHead(await loadLayoutModules(route), mod, {
        data,
        params: c.params,
      })
      const hydrateRoute = mod.hydrate !== false
      // A full-page POST streams the action's `defer()`'d parts mid-document behind `<Await>` too —
      // `renderPage` splits `actionData` like loader data (works with JS off; hydrates after).
      return renderPageResult({
        adapter,
        chain,
        data,
        actionData: actionResult,
        head,
        clientEntry,
        routeId: route.id,
        hydrate: hydrateRoute,
        ...preloadOf(route.id),
        ...stylesOf(route.id),
        prerenderedPaths: options.prerenderedPaths ?? [],
        ...titleOption,
      })
    })
  }

  // Wildcard catch-all: unmatched paths render `_404` (404), or a plain text 404 if absent.
  app.register("GET", "/*", undefined, () => renderNotFound())

  return app
}

export interface GenerateClientEntryOptions {
  /** Module specifier for the adapter's client runtime (exports `mountRouter`), e.g.
   * `"@nifrajs/web-solid/client"`. */
  readonly clientModule: string
  /** Turn a route/layout source file (relative to the routes dir) into an import specifier. */
  readonly resolve: (file: string) => string
}

/**
 * Codegen: emit a client-entry module (as source) that lazily imports each route's layout chain
 * (so `Bun.build` with `splitting` code-splits one chunk per route), builds a `patterns` list,
 * then creates the agnostic router store (with a `loadModule` hook), installs history + form
 * interception, loads the initial route's chunk, and hydrates the adapter's stateful Router. The
 * initial route is derived from the URL (falling back to the server-injected route id, e.g.
 * `_404`), so after hydration the Router owns navigation and swaps routes without full reloads.
 * Bun has no `import.meta.glob`, so file-based routing needs this. Write the result to a file and
 * bundle it with `buildClient` / `Bun.build` (+ the adapter's transform).
 */
export function generateClientEntry(
  manifest: Manifest,
  options: GenerateClientEntryOptions,
): string {
  const { clientModule, resolve } = options

  const loaderRows: string[] = []
  const patternRows: string[] = []
  // Routes whose loader appends a nearest `_error` module (LAST) — the client wraps the page in the
  // adapter's `errorBoundary(fallback)` for these, so a client render error shows the `_error` UI.
  const errorRouteIds: string[] = []
  // Lazy loader returns the raw modules (for both the component chain + the page's `meta` export).
  const lazyLoader = (files: readonly string[]): string => {
    const imports = files.map((f) => `import(${JSON.stringify(resolve(f))})`).join(", ")
    return `() => Promise.all([${imports}])`
  }
  for (const route of manifest.routes) {
    // layoutIds only reference layouts present in the manifest (buildManifest invariant).
    const files = [
      ...route.layoutIds.map((id) => (manifest.layouts[id] as LayoutEntry).file),
      route.file,
    ]
    // Append the nearest `_error` file LAST, so loadModule can pull it off the tail and wrap the page.
    const nearestErrorId = route.errorIds?.at(-1)
    const errorFile =
      nearestErrorId === undefined ? undefined : manifest.errors?.[nearestErrorId]?.file
    if (errorFile !== undefined) {
      files.push(errorFile)
      errorRouteIds.push(route.id)
    }
    loaderRows.push(`  ${JSON.stringify(route.id)}: ${lazyLoader(files)},`)
    patternRows.push(
      `  { routeId: ${JSON.stringify(route.id)}, pattern: ${JSON.stringify(route.pattern)} },`,
    )
  }
  if (manifest.notFound !== undefined) {
    loaderRows.push(`  "_404": ${lazyLoader([manifest.notFound.file])},`)
  }

  return `${[
    'import { createClientRouter, createMatcher, mergeHeads, resolveMeta } from "@nifrajs/web"',
    'import { applyHead, installForms, installHistory } from "@nifrajs/web/client"',
    // Namespace import: `errorBoundary` is optional (an adapter may not export it). A namespace member
    // access yields `undefined` if absent — unlike a named import, which would be a link error.
    `import * as __adapter from ${JSON.stringify(clientModule)}`,
    "const { mountRouter } = __adapter",
    "const errorBoundary = __adapter.errorBoundary",
    `const errorRouteIds = new Set(${JSON.stringify(errorRouteIds)})`,
    // Each route is a lazy loader: dynamic imports → Bun.build (splitting) emits one chunk per
    // route, shared layouts/deps deduped into shared chunks, so a route's code loads only when
    // visited. loadModule caches the [layouts…, page] component chain + the chain's meta list per id.
    "const loaders = {",
    ...loaderRows,
    "}",
    "const chains = {}",
    "const metas = {}",
    "const loadModule = async (id) => {",
    "  if (chains[id]) return",
    "  const mods = await loaders[id]()",
    // For an error route the `_error` module is appended LAST: wrap the page (now second-to-last) in
    // the adapter's boundary so a client render error renders the `_error` UI. DOM-transparent, so the
    // hydrated tree matches the SSR markup (which has no boundary). Falls back to the plain chain when
    // the adapter has no `errorBoundary`.
    // `metas[id]` is the chain's `meta` exports in head order (outermost layout → … → page), so a
    // soft-nav merges the layout chain's head with the page's — matching the SSR `<head>` (sitewide
    // layout tags persist across client navigation, no flash of page-only head). `_error` carries no
    // head (a terminal boundary), so it's excluded from the meta list for error routes.
    "  if (errorBoundary && errorRouteIds.has(id)) {",
    "    const fallback = mods[mods.length - 1].default",
    "    const page = mods[mods.length - 2].default",
    "    const layouts = mods.slice(0, mods.length - 2).map((m) => m.default)",
    "    chains[id] = [...layouts, errorBoundary(fallback), page]",
    "    metas[id] = mods.slice(0, mods.length - 1).map((m) => m.meta)",
    "  } else {",
    "    chains[id] = mods.map((m) => m.default)",
    "    metas[id] = mods.map((m) => m.meta)",
    "  }",
    "}",
    "const patterns = [",
    ...patternRows,
    "]",
    // Derive the initial route from the URL (correct on refresh/deep-link); fall back to the
    // server-injected route id for non-pattern routes (e.g. _404, which matches nothing).
    "const matched = createMatcher(patterns)(location.pathname)",
    // Map any `{__nifra_deferred: id}` placeholder in the SSR data to the registry's promise, so the
    // component receives real promises to `<Await>` (a no-op when a page has no deferred data).
    MAP_DEFERRED_SOURCE,
    "const initial = {",
    `  routeId: matched ? matched.routeId : (window.${ROUTE_GLOBAL} ?? ""),`,
    "  params: matched ? matched.params : {},",
    "  path: location.pathname,",
    `  data: mapDeferred(window.${DATA_GLOBAL}),`,
    // actionData (only set after a form POST) is in the initial state so the binding hydrates
    // consistently with the server-rendered markup; mapped through `mapDeferred` too so a deferred
    // action's placeholders become registry markers (a no-op when the action didn't defer).
    `  actionData: mapDeferred(window.${ACTION_GLOBAL}),`,
    "  pending: false,",
    "}",
    "const router = createClientRouter({ patterns, initial, loadModule })",
    "installHistory(router)",
    "installForms(router)",
    'const root = document.getElementById("root")',
    // Load the initial route's chunk, then hydrate the Router (chain is cached). The initial head
    // is server-rendered; subsequent navigations update it from the matched route's meta + data.
    "if (root) loadModule(initial.routeId).then(() => {",
    "  mountRouter({ router, routes: chains, container: root })",
    "  router.subscribe(() => {",
    "    const s = router.snapshot()",
    // Merge the matched route's chain meta (layouts→page) into one head — same contract as SSR.
    "    if (!s.pending) {",
    "      const args = { data: s.data, params: s.params }",
    "      applyHead(mergeHeads((metas[s.routeId] ?? [undefined]).map((m) => resolveMeta(m, args))))",
    "    }",
    "  })",
    "})",
  ].join("\n")}\n`
}

export interface GenerateServerManifestOptions {
  /** Turn a route/layout source file (relative to the routes dir) into an import specifier —
   * same contract as `generateClientEntry`'s `resolve`. */
  readonly resolve: (file: string) => string
  /** The content-hashed client entry URL (from `buildClient`'s manifest), **baked** into the emitted
   * module — a disk-less worker can't read `manifest.json` at runtime. */
  readonly clientEntry: string
  /** Emit **lazy** per-route loaders (`() => import("./routes/x")`, a static specifier) instead of
   * eager `import * as`, so a bundler with code-splitting emits one chunk per route — loaded on the
   * first request to it, not all at boot (smaller cold-start parse). Default `false` (eager). Both
   * modes are fs-free with statically-analyzable specifiers; only the *when* differs. */
  readonly lazy?: boolean
}

/**
 * Codegen: emit a **server manifest** module (as source) for disk-less edge runtimes (Cloudflare
 * Workers, …) — and, with a `target`, any portable server bundle. `discoverRoutes` scans `node:fs`
 * and dynamic-imports each route by a *runtime* path — neither exists on workerd. This instead emits
 * **statically-analyzable** imports of every route/layout/`_error`/`_404` (so the bundler includes them) and
 * rebuilds the manifest with `buildManifest` — the SAME pure logic `discoverRoutes` feeds, so patterns
 * + layout chains are identical. Eager (`import * as`) by default; `lazy` emits `() => import(...)` so
 * a code-splitting bundler chunks per route. The emitted module exports `manifest` (consumed by
 * `createWebApp`, unchanged) + `clientEntry` (baked). Write it to a file and bundle it into the worker
 * entry (see `buildServer` in `@nifrajs/web/build`).
 */
export function generateServerManifest(
  manifest: Manifest,
  options: GenerateServerManifestOptions,
): string {
  const { resolve, clientEntry, lazy = false } = options
  // Every unique source file in the manifest (routes + layouts + `_error` + `_404`), sorted for stable output.
  const files = [
    ...new Set([
      ...manifest.routes.map((r) => r.file),
      ...Object.values(manifest.layouts).map((l) => l.file),
      ...Object.values(manifest.errors ?? {}).map((e) => e.file),
      ...(manifest.notFound ? [manifest.notFound.file] : []),
    ]),
  ].sort()
  const header = [
    "// GENERATED by @nifrajs/web generateServerManifest — route manifest for the disk-less edge",
    "// (no filesystem; route imports are static specifiers the bundler resolves). buildManifest is",
    "// the same pure logic discoverRoutes feeds, so patterns + layout chains match exactly.",
    'import { buildManifest } from "@nifrajs/web"',
  ]
  const clientEntryLine = `export const clientEntry = ${JSON.stringify(clientEntry)}`
  if (lazy) {
    // Lazy: `() => import("./routes/x")` per route (static specifier → one chunk per route under a
    // code-splitting bundler, loaded on first request). The map keys are the route-relative paths
    // `buildManifest` expects; the importer it builds calls the per-file loader.
    const loaders = files.map(
      (file) => `  ${JSON.stringify(file)}: () => import(${JSON.stringify(resolve(file))}),`,
    )
    return `${[
      ...header,
      "const loaders = {",
      ...loaders,
      "}",
      clientEntryLine,
      "export const manifest = buildManifest(Object.keys(loaders), (file) => () => loaders[file]())",
    ].join("\n")}\n`
  }
  // Eager: `import * as` per route (all bundled into the entry, parsed at boot). Index-based
  // identifiers are collision-proof regardless of filename.
  const imports = files.map((file, i) => `import * as m${i} from ${JSON.stringify(resolve(file))}`)
  const entries = files.map((file, i) => `  ${JSON.stringify(file)}: m${i},`)
  return `${[
    ...header,
    ...imports,
    "const modules = {",
    ...entries,
    "}",
    clientEntryLine,
    "export const manifest = buildManifest(Object.keys(modules), (file) => () => Promise.resolve(modules[file]))",
  ].join("\n")}\n`
}
