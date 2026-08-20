import { isSameOriginPath, type ResponseResult, status as statusResult } from "@nifrajs/core/server"
import type { BoundaryRegistration, BoundaryStates } from "../boundary.ts"
import { DEFERRED_ERROR_CODE, DEFERRED_RUNTIME, prepareDeferred } from "../deferred.ts"
import { ISR_REVALIDATE_HEADER, ISR_REVALIDATE_TAGS_HEADER, serializeISRTags } from "../isr.ts"
import type {
  Loader as LayoutLoader,
  LinkDescriptor,
  Meta,
  MetaDescriptor,
  MetaInput,
  RouteModule,
  ScriptDescriptor,
  UnsafeScriptDescriptor,
} from "../manifest.ts"
import type { RenderAdapter, RenderProps } from "../render-seam.ts"
import {
  ACTION_GLOBAL,
  BOUNDARY_GLOBAL,
  DATA_GLOBAL,
  LAYOUT_DATA_GLOBAL,
  ROOT_ATTRIBUTE,
  ROUTE_GLOBAL,
} from "../render-seam.ts"
import { PRERENDERED_GLOBAL, REDIRECT_HEADER } from "../router.ts"
import { trustedHeadAttributes } from "./head-attributes.ts"
import { isStaticMeta, mergeHeads } from "./head-merge.ts"
import { PRE_HYDRATION_GUARD } from "./runtime-contract.ts"
import { EXECUTABLE_SCRIPT_TYPES, INERT_SCRIPT_TYPES } from "./script-types.ts"

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

/**
 * A control-flow value that renders as plain data - what `redirect()` returns, and what core's
 * `status(...)` returns. Recognized here rather than imported: core keeps its own predicate internal,
 * and the registry symbol is the contract between them (two copies of core must still agree).
 */
const isResponseResult = (value: unknown): value is ResponseResult =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly [RESPONSE_RESULT]?: unknown })[RESPONSE_RESULT] === true &&
  typeof (value as { readonly toResponse?: unknown }).toResponse === "function"

/** A returned/thrown value that ends the request as-is: either shape of control-flow signal. */
export const isControlFlow = (value: unknown): value is Response | ResponseResult =>
  value instanceof Response || isResponseResult(value)

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
  /** The layout chain to render - outermost layout → page (opaque; the adapter renders it). */
  readonly chain: readonly unknown[]
  /** The loader output for this request. */
  readonly data: unknown
  /** An action's data return (POST only) - surfaced to the page as `actionData` + serialized
   * for the client so post-POST hydration matches. Omit on GETs. */
  readonly actionData?: unknown
  /**
   * URL of the built client entry (loaded as a module script).
   *
   * Optional ONLY on a `hydrate: false` page, where there is no client takeover to feed and this value
   * reaches no output at all. The union below is what enforces that: omitting it on a hydrating page
   * stays a compile error rather than rendering `src=""`.
   */
  readonly clientEntry?: string
  /** Chunk URLs for the **matched** route (its layout chain + own chunk) to `modulepreload` in the
   * shell - so the route code downloads in parallel with the entry instead of after it
   * (`buildClient`'s per-route map). Empty/omitted ⇒ only the entry is preloaded (unchanged). */
  readonly preload?: readonly string[]
  /** Stylesheet URLs for the **matched** route (its layout chain + own CSS, from `buildClient`'s
   * `BuildManifest.css`) - injected as `<link rel="stylesheet">` in `<head>` so styles arrive with the
   * first paint (no FOUC). Rendered even on non-hydrated pages. Empty/omitted ⇒ none (unchanged). */
  readonly styles?: readonly string[]
  /** SSG: the prerendered-path set, serialized to `window.__NIFRA_PRERENDERED__` so the client fetches
   * a static `_data.json` on soft-nav into a prerendered route. Empty/omitted ⇒ not injected. */
  readonly prerenderedPaths?: readonly string[]
  /** ISR: route freshness in seconds, emitted as the `x-nifra-isr-revalidate` header for a `withISR`
   * wrapper to read. Omit ⇒ no header (the wrapper's default TTL applies). */
  readonly revalidate?: number
  /** ISR invalidation tags emitted as a bounded `x-nifra-isr-tags` header. */
  readonly revalidateTags?: readonly string[]
  /** Matched route id; written to `window.__NIFRA_ROUTE__` so the client hydrates this chain. */
  readonly routeId?: string
  /** The matched route's decoded path params - surfaced to the page as `params` (via {@link RenderProps})
   * so an adapter's `useParams` is SSR-correct. Omit ⇒ `{}` (a route with no dynamic segments, or an
   * error/404 render). */
  readonly params?: Readonly<Record<string, string>>
  /** The request's `pathname + search` - surfaced as `path` (via {@link RenderProps}) so an adapter's
   * `useLocation`/`useSearchParams` render the right URL server-side and hydrate without drift. Omit ⇒
   * `""`. */
  readonly path?: string
  /** The route's validated search (`searchOf(mod.searchSchema, url.search)`, the same value handed to
   * the loader as `ctx.search`), surfaced as `search` (via {@link RenderProps}) so an adapter's
   * `useSearch` is SSR-correct. Omit ⇒ `{}` (a render with no search context). */
  readonly search?: Record<string, unknown>
  /** Per-layout loader data, forwarded to the adapter as `RenderProps.layoutData`. Aligned with the
   * chain's layout prefix; omitted when no layout in the chain has a loader. */
  readonly layoutData?: readonly unknown[]
  /** Dynamic-boundary states, forwarded to the adapter and serialized for hydration when present. */
  readonly boundaries?: BoundaryStates
  /** HTTP status for the response (default 200; e.g. 404 for a not-found page). */
  readonly status?: number
  /** Extra response headers - e.g. the `cache-control` a terminal status page wants. `content-type`
   * is ignored (the document is always HTML) and the ISR freshness header is applied after these,
   * so neither can be overridden from here. */
  readonly headers?: HeadersLike
  /** Document title (fallback when `head.title` is unset). */
  readonly title?: string
  /** Resolved route head - `title` overrides `title` above; `meta`/`link` render as managed
   * (`data-nifra`) tags the client updates on navigation.
   *
   * **Head contract (the layout chain contributes).** `createWebApp` resolves this via
   * {@link mergeHeads}: a route's head is its **layout chain's** `meta`/`head` exports merged with the
   * page's. A `_layout.tsx` may `export const meta` (or `export function meta(args)`) - its tags land
   * on every page below it (the home for `hreflang`, `preconnect`, a section-default `<title>`). The
   * merge is **nearest-wins for scalars** (the page's `title` overrides an inner layout's, which
   * overrides an outer one; an undefined page title keeps the layout's) and **concatenated for the
   * `meta`/`link` arrays** (outermost layout first, page last). `<meta>`/`<link>` attributes pass a
   * shared tag-specific allowlist (including inert `data-*` metadata) and values are escaped. */
  readonly head?: Meta
  /** Id of the container wrapping the app markup (default `"root"`). A non-default id also gets
   * {@link ROOT_ATTRIBUTE}, which is how the generated client entry finds the container to hydrate -
   * the entry is built once and cannot know what a given render chose. */
  readonly rootId?: string
  /** When `false`, emit a complete but **non-hydrated** document - no client entry script, data
   * globals, or modulepreloads. Used for server-rendered `_error` pages: a terminal state that needs no
   * client takeover, and it sidesteps an SSR/hydrate mismatch (the server rendered the boundary, not
   * the page the client manifest maps this route id to). Default `true`. */
  readonly hydrate?: boolean
  /** Island client bundles (`@nifrajs/web/islands`) to load as `<script type="module">` in the document
   * tail - emitted **regardless of `hydrate`**, so a static (`hydrate: false`) page can still mount
   * no-framework islands. URLs are attribute-escaped. Empty/omitted ⇒ none (unchanged output). */
  readonly islandScripts?: readonly string[]
  /** CSP nonce applied to every framework-owned executable script in this document. */
  readonly nonce?: string
  /**
   * Advanced: a per-route slot the renderer fills with the request-invariant document pieces (shell
   * prefix/suffix, tail statics) on the first render and reuses afterwards, skipping their re-assembly.
   *
   * Only pass a cache when every shell-shaping input is IDENTICAL across the requests sharing it:
   * same `head` content (a static meta chain - never a `meta(data)` function), `title`, `styles`,
   * `preload`, `islandScripts`, `clientEntry`, `rootId`, `hydrate`, and `prerenderedPaths`. Per-request
   * values (`data`, `params`, `search`, `actionData`, `layoutData`, deferred state) are always assembled
   * fresh and safe. A per-request `nonce` disables the cache automatically. `createWebApp` wires this
   * per route, gated on the route + layout metas being static.
   */
  readonly assemblyCache?: RenderAssemblyCache
}

/** The mutable per-route slot {@link RenderPageOptions.assemblyCache} fills. Opaque - create as `{}`. */
export interface RenderAssemblyCache {
  /** Shell up to (not including) the deferred-runtime insertion point. */
  shellPre?: string
  /** Shell from after the deferred-runtime insertion point through the open `#root` container. */
  shellPost?: string
  /** Tail opener: the inline script open tag + the route-id global (before the action global). */
  tailPre?: string
  /** Tail mid: the prerendered-paths global (between the action and layout-data globals). */
  tailMid?: string
  /** Tail data prefix: the `window.<data global>=` assignment head. */
  tailData?: string
  /** Tail from after the serialized data through `</html>`. */
  tailPost?: string
}

/**
 * `renderPage` input. A hydrating page (the default) must supply `clientEntry`, because the document
 * loads it as a module script; a `hydrate: false` page may omit it, because nothing in the emitted
 * document references it. Expressed as a union so the compiler enforces the pairing rather than the
 * renderer discovering an empty `src` at runtime.
 */
export type RenderPageInput = RenderPageOptions &
  ({ readonly hydrate?: true; readonly clientEntry: string } | { readonly hydrate: false })

/**
 * Server: render a full HTML document for a page - the adapter's hydration head + the SSR
 * markup (**streamed**) + the serialized loader data + the client module - as a `Response`.
 * The shell (`<head>` + the open container) flushes first, the adapter's app stream follows,
 * then the tail (data globals + client entry). Pure Web Standards, so it returns straight from
 * a nifra route handler and streams on any fetch runtime (Bun/Node/Deno/Workers).
 */
export function renderPage(options: RenderPageInput): MaybePromise<Response> {
  const page = renderPageResult(options)
  return page instanceof Promise ? page.then((p) => p.toResponse()) : page.toResponse()
}

export function renderPageResult(options: RenderPageInput): MaybePromise<RenderedPage> {
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
    revalidateTags = [],
    routeId,
    status = 200,
    title = "nifra",
    head,
    rootId = "root",
    hydrate = true,
    islandScripts = [],
    nonce,
    boundaries,
    headers: extraHeaders,
  } = options
  if (nonce !== undefined && nonce.trim() === "") {
    throw new TypeError("[nifra/web] renderPage nonce must be non-empty when provided")
  }
  const nonceAttr = nonce === undefined ? "" : ` nonce="${escapeAttr(nonce)}"`
  const route = routeId === undefined ? "" : `window.${ROUTE_GLOBAL}=${serializeData(routeId)};`
  // The SSG prerendered-path set (when an app declares it) - the client reads it to fetch a static
  // `_data.json` on soft-nav into a prerendered route instead of hitting the worker. Empty ⇒ omitted.
  const prerendered =
    prerenderedPaths.length === 0
      ? ""
      : `window.${PRERENDERED_GLOBAL}=${serializeData(prerenderedPaths)};`
  // Split deferred values: the component sees markers (id + promise) to `<Await>`; the serialized
  // data carries `{__nifra_deferred: id}` placeholders (promises don't serialize). `actionData` may
  // also `defer()` - split it too, continuing the id space so a single registry settles both. The
  // inline registry runtime is emitted only when something defers, so non-deferred output is unchanged.
  const { forComponent, forClient, deferred } = prepareDeferred(data)
  // Each layout's data is split in turn, each continuing the id space, so a `defer()` in a layout
  // settles through the SAME registry as the page's rather than colliding on ids.
  const layoutSplits: Array<ReturnType<typeof prepareDeferred>> = []
  if (options.layoutData !== undefined) {
    let offset = deferred.length
    for (const entry of options.layoutData) {
      const split = prepareDeferred(entry, offset)
      offset += split.deferred.length
      layoutSplits.push(split)
    }
  }
  const layoutDeferred = layoutSplits.flatMap((split) => split.deferred)
  const actionSplit =
    actionData === undefined
      ? undefined
      : prepareDeferred(actionData, deferred.length + layoutDeferred.length)
  const boundarySplit =
    boundaries === undefined
      ? undefined
      : prepareDeferred(
          boundaries,
          deferred.length + layoutDeferred.length + (actionSplit?.deferred.length ?? 0),
        )
  // On the common page-only path (no layout loader, no action) reuse `deferred` directly instead of
  // allocating a fresh spread array every request.
  const allDeferred =
    layoutDeferred.length === 0 && actionSplit === undefined && boundarySplit === undefined
      ? deferred
      : [
          ...deferred,
          ...layoutDeferred,
          ...(actionSplit ? actionSplit.deferred : []),
          ...(boundarySplit ? boundarySplit.deferred : []),
        ]
  // Omitted entirely when no layout has a loader - a page-only app emits exactly what it did before.
  const layoutTail =
    options.layoutData === undefined
      ? ""
      : `window.${LAYOUT_DATA_GLOBAL}=${serializeData(layoutSplits.map((split) => split.forClient))};`

  // Only emit the action global when an action actually ran, so plain GET output is unchanged.
  const action =
    actionSplit === undefined
      ? ""
      : `window.${ACTION_GLOBAL}=${serializeData(actionSplit.forClient)};`
  const boundaryTail =
    boundarySplit === undefined
      ? ""
      : `window.${BOUNDARY_GLOBAL}=${serializeData(boundarySplit.forClient)};`
  const deferredRuntime =
    allDeferred.length > 0 ? `<script${nonceAttr}>${DEFERRED_RUNTIME}</script>` : ""
  // The regex only injects the CSP nonce into the (constant) hydration head; with no nonce it's a
  // no-op that still scans the whole script every request. Skip it on the common no-nonce path.
  // The request-invariant document pieces. With a caller-supplied per-route cache (and no per-request
  // nonce, which would bake into them) they're built once and reused; the per-request seams - the
  // deferred runtime in the shell, the action/layout-data globals and the serialized loader data in
  // the tail - are always assembled fresh. Byte-identical to building the whole document inline.
  const slot: RenderAssemblyCache =
    nonce === undefined && options.assemblyCache !== undefined ? options.assemblyCache : {}
  if (slot.shellPre === undefined) {
    // Matched-route chunk preloads, concatenated directly. De-duped against the entry, which is
    // preloaded separately below.
    let preloadLinks = ""
    for (const url of preload) {
      if (url !== clientEntry)
        preloadLinks += `<link rel="modulepreload" href="${escapeAttr(url)}">`
    }
    // The matched route's stylesheets - `<link rel="stylesheet">` in `<head>` so CSS arrives with the
    // first paint (no FOUC). Render-blocking by design, and emitted regardless of `hydrate` (a static
    // or `_error` page still wants its styles). In dev (Vite) CSS is injected client-side instead.
    let styleLinks = ""
    for (const url of styles) styleLinks += `<link rel="stylesheet" href="${escapeAttr(url)}">`
    // Island bundles are referenced only by a `<script type="module">` at the END of `<body>`, so the
    // browser doesn't discover them until the whole page is parsed. `modulepreload` them in `<head>`
    // so the fetch starts immediately, in parallel with parsing - regardless of `hydrate`.
    let islandPreloads = ""
    for (const src of islandScripts)
      islandPreloads += `<link rel="modulepreload" href="${escapeAttr(src)}">`
    // Runs in the first-paint→hydration window to swallow a JS-only form's broken native submit. Only
    // on a hydrating page (a static/_error page has no client handlers, so no footgun).
    const hydrationGuard = hydrate ? `<script${nonceAttr}>${PRE_HYDRATION_GUARD}</script>` : ""
    // `<html>` attributes. `lang` defaults to `"en"`; `dir` is omitted entirely when unset, which IS
    // HTML's `ltr` default. Both attribute-escaped. `client.ts`'s `applyHead` mirrors this exact
    // defaulting on soft-nav, so a hard load and a client navigation produce the same `<html>`.
    const htmlAttrs = ` lang="${escapeAttr(head?.lang ?? "en")}"${head?.dir === undefined ? "" : ` dir="${escapeAttr(head.dir)}"`}`
    // Marks the container for the client entry when the id is not the one the entry falls back to.
    const rootMarker = rootId === "root" ? "" : ` ${ROOT_ATTRIBUTE}`
    // A non-hydrated page omits the adapter's hydration bootstrap entirely (Solid's `_$HY` registry
    // script, etc.) - there is no client takeover to feed, so it's dead bytes on a static document.
    // The nonce rewrite only runs when a nonce is set; with none it was a whole-string no-op scan.
    const rawHydrationHead = hydrate ? adapter.hydrationHead(nonce) : ""
    const hydrationHead =
      nonce === undefined
        ? rawHydrationHead
        : rawHydrationHead.replace(/<script(?![^>]*\bnonce=)(?=[\s>])/g, `<script${nonceAttr}`)
    // Shell up to the deferred-runtime seam: on a hydrating page that seam sits after the entry +
    // route-chunk preloads; a non-hydrating page has no runtime insertion at all.
    const entryPreloads = hydrate
      ? `<link rel="modulepreload" href="${escapeAttr(clientEntry ?? "")}">${preloadLinks}`
      : ""
    slot.shellPre = `<!doctype html><html${htmlAttrs}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${hydrationGuard}<title>${escapeHtml(head?.title ?? title)}</title>${headTags(head)}${styleLinks}${entryPreloads}`
    slot.shellPost = `${islandPreloads}${hydrationHead}</head><body><div id="${escapeAttr(rootId)}"${rootMarker}>`
    // Island bundles load regardless of `hydrate` - a static page (hydrate:false) ships no framework
    // client but can still mount no-framework islands (`@nifrajs/web/islands`).
    let islandTags = ""
    for (const src of islandScripts)
      islandTags += `<script type="module" src="${escapeAttr(src)}"${nonceAttr}></script>`
    if (hydrate) {
      slot.tailPre = `<script${nonceAttr}>${route}`
      slot.tailMid = prerendered
      slot.tailData = `window.${DATA_GLOBAL}=`
      slot.tailPost = `</script><script type="module" src="${escapeAttr(clientEntry ?? "")}"${nonceAttr}></script>${islandTags}</body></html>`
    } else {
      slot.tailPre = ""
      slot.tailMid = ""
      slot.tailData = ""
      slot.tailPost = `${islandTags}</body></html>`
    }
  }
  // The deferred runtime rides only on a hydrating page (a static page has no client takeover), and
  // only when something actually deferred - matching the pre-cache emission exactly.
  const runtimeSeam = hydrate && allDeferred.length > 0 ? deferredRuntime : ""
  const shellHtml = `${slot.shellPre}${runtimeSeam}${slot.shellPost}`
  // Closes the hydration container; deferred resolve scripts go AFTER it (outside `#root`) so they
  // aren't part of the adapter's hydrated tree (an inline script inside it breaks hydration).
  const closeRootHtml = "</div>"
  // Tail - the loader-data globals + the client module. Module scripts defer (run after parse), so
  // the data global + every streamed deferred resolution are set before the entry hydrates.
  const tailHtml = hydrate
    ? `${slot.tailPre}${action}${slot.tailMid}${layoutTail}${boundaryTail}${slot.tailData}${serializeData(forClient)}${slot.tailPost}`
    : (slot.tailPost as string)
  const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" }
  // Caller-supplied headers (a terminal status page's `cache-control`, say). Applied before the
  // framework's own below, so `content-type` and the ISR channel stay authoritative - a caller must
  // not be able to mislabel the document or forge the freshness header by passing them here.
  if (extraHeaders !== undefined) {
    for (const [name, value] of new Headers(extraHeaders)) {
      if (name !== "content-type") headers[name] = value
    }
  }
  // ISR: advertise the route's freshness so a `withISR` wrapper can set this page's cache TTL. A
  // dedicated header (not the action-revalidation `x-nifra-revalidate`) so the TTL channel never aliases
  // the client's path-list channel.
  if (revalidate !== undefined) headers[ISR_REVALIDATE_HEADER] = String(revalidate)
  const serializedTags = serializeISRTags(revalidateTags)
  if (serializedTags !== undefined) headers[ISR_REVALIDATE_TAGS_HEADER] = serializedTags
  const renderProps: RenderProps = {
    data: forComponent,
    actionData: actionSplit?.forComponent,
    // `params`/`path` thread the matched route + URL to the adapter's `useParams`/`useLocation` so they
    // render SSR-correct. Spread only when supplied (exactOptionalPropertyTypes) - an adapter with no
    // router bindings simply never reads them.
    ...(options.params !== undefined ? { params: options.params } : {}),
    ...(options.path !== undefined ? { path: options.path } : {}),
    // Same rule for `search`: the validated query the adapter's `useSearch` reads, spread only when the
    // caller supplied it (a non-router render never has it).
    ...(options.search !== undefined ? { search: options.search } : {}),
    // Spread only when present, so a page-only render produces exactly the props it did before.
    ...(options.layoutData !== undefined
      ? { layoutData: layoutSplits.map((split) => split.forComponent) }
      : {}),
    ...(boundarySplit !== undefined
      ? { boundaries: boundarySplit.forComponent as BoundaryStates }
      : {}),
  }

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
    nonceAttr,
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
  nonceAttr: string,
): Promise<Response> {
  // Streaming path - required for `defer()` (progressive `<Await>` resolution) and used by any adapter
  // that doesn't implement `renderToString`. Awaiting `renderToStream` resolves on shell-readiness
  // (React: on-shell-ready; Solid: synchronously), so a shell-render throw surfaces before any byte is
  // sent. A *mid*-stream failure errors the body instead.
  const enc = TEXT_ENCODER
  const shell = enc.encode(shellHtml)
  const closeRoot = enc.encode(closeRootHtml)
  const tail = enc.encode(tailHtml)
  const appStream = await adapter.renderToStream(chain, renderProps)
  const body = streamDocument(shell, appStream, closeRoot, allDeferred, tail, enc, nonceAttr)
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
 * script per deferred value (emitted once its promise settles - by now the app stream has awaited
 * the same Suspense boundaries - and placed OUTSIDE `#root`) → `tail`. A mid-stream app error errors
 * the result (the body breaks) rather than silently truncating a 200.
 */
function streamDocument(
  shell: Uint8Array,
  stream: ReadableStream<Uint8Array>,
  closeRoot: Uint8Array,
  deferred: ReadonlyArray<{ readonly id: number; readonly promise: Promise<unknown> }>,
  tail: Uint8Array,
  enc: TextEncoder,
  nonceAttr: string,
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
        // Stream each resolution as ITS OWN promise settles - NOT in array order. A slow
        // defer() must not block a faster one; each script self-addresses by id, so order is irrelevant.
        await Promise.all(
          deferred.map(async (d) => {
            try {
              const value = serializeData(await d.promise)
              controller.enqueue(
                enc.encode(`<script${nonceAttr}>window.__nifraResolve(${d.id},${value})</script>`),
              )
            } catch (err) {
              // A rejected deferred streams __nifraReject (the client `<Await>` surfaces it) - it must
              // not break the whole body. Redact: stream a stable opaque code, never the raw error
              // text; log the real reason server-side.
              console.error("[nifra/web] deferred value rejected:", err)
              controller.enqueue(
                enc.encode(
                  `<script${nonceAttr}>window.__nifraReject(${d.id},${serializeData(DEFERRED_ERROR_CODE)})</script>`,
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
  /** Extra response headers. A redirect is no longer a `Response`, so there is no `.headers` to
   * mutate after the fact - name them here. Cookies still ride `c.set`, as on any other response. */
  readonly headers?: Readonly<Record<string, string>>
}

/** A same-origin destination is an absolute path: one leading `/`, but NOT `//` (protocol-relative →
 * another origin), and nothing a URL parser resolves off-origin. Everything else (absolute URL with
 * a scheme, `//host`, `javascript:`, a bare relative `foo`) requires `external: true`. The predicate
 * lives in the kernel - see `isSameOriginPath` - so this gate and the auth guards' `redirectTo`
 * cannot drift apart. */

/**
 * Build a redirect - return it from a route `action` for the Post/Redirect/Get pattern (POST
 * mutates, 303 sends the browser to a fresh GET, so a reload doesn't re-submit). Defaults to 303
 * (See Other); pass `{ status: 307 }` or `{ status: 308 }` to preserve the method.
 *
 * **Secure by default:** `location` must be a same-origin path (begins with `/`, not `//`). An
 * off-origin/absolute destination throws unless you pass `{ external: true }` - this closes the
 * open-redirect footgun of `return redirect(formData.get("next"))` on the no-JS (native-form) path,
 * which serves the action's control-flow value verbatim.
 *
 * Returns a plain render, not a `Response`. A redirect is a status line and one header - the most
 * body-less response there is - and building a `Response` for it costs the whole Web object plus, on
 * Node, a stream drained back out. As data it renders on the same lane a handler's return takes.
 * `redirect(...)` is still returned or thrown from exactly the same places; only `.status` /
 * `.headers` are gone from the value, replaced by `options.headers` and the request's `c.set`.
 *
 * @param options redirect status, extra headers, and whether an off-origin destination is intentional.
 */
export function redirect(location: string, options: RedirectOptions = {}): ResponseResult {
  if (options.external !== true && !isSameOriginPath(location)) {
    throw new Error(
      `[nifra/web] redirect(${JSON.stringify(location)}) is not a same-origin path. Use a path beginning with "/" (not "//", no backslash or control character), or redirect(location, { external: true }) for a deliberate off-origin redirect. This guards against open redirects from unvalidated input.`,
    )
  }
  // Reject CR/LF in the Location explicitly - defense-in-depth (response splitting / header
  // injection). Spec-correct runtimes' Headers setter throws on CR/LF, but `external: true` lets
  // unvalidated input reach this sink, so we don't rely on the runtime. Same posture as
  // serializeCookie / the SSE frame formatter, which strip CRLF at their sinks.
  if (/[\r\n]/.test(location)) {
    throw new Error(
      `[nifra/web] redirect location contains a CR/LF character - refusing to emit a header-injecting redirect.`,
    )
  }
  return statusResult(options.status ?? 303, undefined, {
    headers: options.headers === undefined ? { location } : { ...options.headers, location },
  })
}

/**
 * Brand marking a `Response` as a **terminal-status signal** rather than a response to serve verbatim.
 *
 * A loader that throws a bare `Response` has always been passed straight through - that is how
 * `throw redirect(...)` works, and apps rely on it. So "render the `_404` boundary at 404" cannot be
 * expressed by throwing a plain `Response`: the framework would have no way to tell it apart from a
 * hand-rolled body the app wants served exactly as written. The brand is that distinction, and
 * checking it *before* the pass-through is what keeps every existing throw working unchanged.
 *
 * `Symbol.for` matches `RESPONSE_RESULT` above: a registry symbol survives two copies of this module,
 * which a `unique symbol` would not - and a duplicate-install turning a 404 into a raw 404 body would
 * be a maddening bug to trace.
 */
/** Derived from the `Headers` constructor rather than the DOM lib's `HeadersInit`: `@nifrajs/web`
 * is consumed from DOM-free programs (the root tsconfig runs `types: ["bun"]`), and naming the DOM
 * type here would break their build. Same workaround as `SSEInit.headers` in core. */
export type HeadersLike = ConstructorParameters<typeof Headers>[0]

/**
 * The signatures a **duplicate module instance** produces during SSR, across engines.
 *
 * Two copies of React (or of `@nifrajs/core`) at the SAME version still fail, because module identity
 * is path-based: hooks read a dispatcher off the copy that rendered, and the component imported the
 * other one. The error that surfaces names a React internal, so it reads as a React bug and the actual
 * cause - two directories - is a long inference away. Naming the cause at the point of failure is the
 * difference between that and a five-second read.
 */
const DUPLICATE_INSTANCE_SIGNATURES: readonly RegExp[] = [
  /resolveDispatcher\(\)/,
  /Invalid hook call/,
  /Cannot read propert(?:y|ies) of null \(reading '(?:use[A-Z]\w*)'\)/,
  /null is not an object \(evaluating '.*\.use[A-Z]\w*'\)/,
]

/**
 * Append the likely cause to an SSR error that carries a duplicate-instance signature.
 *
 * Deliberately does NOT claim the resolved paths: `@nifrajs/web` is framework-agnostic and does not
 * depend on React, so it cannot resolve the copies without guessing. It names the condition and the
 * command that reports the paths, which is the actionable part. Returns the error untouched when the
 * signature does not match, so an ordinary render error reads exactly as before.
 */
export function withDuplicateInstanceHint(err: unknown): unknown {
  if (!(err instanceof Error)) return err
  if (!DUPLICATE_INSTANCE_SIGNATURES.some((rx) => rx.test(err.message))) return err
  const augmented = new Error(
    `${err.message}\n\n[nifra/web] This signature usually means TWO COPIES of an identity-sensitive package (react, react-dom, or @nifrajs/core) are installed at different paths. Module identity is path-based, so matching versions do NOT fix it - the copies must resolve to the same directory. Run \`nifra check\` to list the paths.`,
    { cause: err },
  )
  augmented.name = err.name
  // `stack` is optional under exactOptionalPropertyTypes; assigning `undefined` would replace a real
  // stack with nothing on engines that always populate it.
  if (err.stack !== undefined) augmented.stack = err.stack
  return augmented
}

/**
 * An action's control-flow value passes straight through - except a redirect on a client-submit data
 * request: fetch would follow the 3xx into HTML the client can't use, so the redirect rides the
 * X-Nifra-Redirect header on a 204 and the client navigates. One conversion shared by the returned-
 * and thrown- paths, so `return redirect()` and `throw redirect()` agree.
 *
 * Takes either shape: `redirect()` is a plain render, while a hand-rolled `new Response(...)` from an
 * action still arrives as a `Response`. The rewrite stays on the lane its input was on - a plain
 * redirect converts to a plain 204, and never materializes the `Response` it is replacing.
 */
export function actionResponse(
  result: Response | ResponseResult,
  isDataRequest: boolean,
): Response | ResponseResult {
  if (!isDataRequest) return result
  if (isResponseResult(result)) {
    const plain = result.plain
    // No `plain` means a carrier that only knows how to build a `Response` (not one of ours) - fall
    // back rather than guess at its status.
    if (plain === undefined) return actionResponse(result.toResponse(), isDataRequest)
    if (plain.status < 300 || plain.status >= 400) return result
    const location = plain.headers?.location ?? "/"
    return statusResult(204, undefined, { headers: { [REDIRECT_HEADER]: location } })
  }
  if (result.status >= 300 && result.status < 400) {
    const location = result.headers.get("location") ?? "/"
    return statusResult(204, undefined, { headers: { [REDIRECT_HEADER]: location } })
  }
  return result
}

/** A loaded layout module. `loader`/`gate` are the layout-loader surface; `meta` predates it. */
export type LoadedLayoutModules = ReadonlyArray<{
  default: unknown
  meta?: MetaInput
  loader?: LayoutLoader
  action?: unknown
  gate?: boolean
  // A layout may declare its own `searchSchema`; the route's effective search merges the layout chain's
  // schemas with the page's (page-wins). Present on the raw module already - typed here so it is readable.
  searchSchema?: RouteModule["searchSchema"]
  boundaries?: readonly BoundaryRegistration[]
}>

/**
 * Narrow the route's params to the ones a layout owns.
 *
 * A layout wraps a URL prefix, so anything deeper belongs to a route beneath it. Handing it the full
 * set would let a layout read a param it does not own - which reads fine until the layout is reused
 * under a route that has no such param and the value silently becomes `undefined`.
 */
export function scopeParams(
  params: Record<string, string>,
  owned: readonly string[] | undefined,
): Record<string, string> {
  if (owned === undefined) return params // hand-built manifest with no scope info: unchanged behaviour
  if (owned.length === 0) return EMPTY_LAYOUT_PARAMS
  const scoped: Record<string, string> = {}
  for (const name of owned) {
    const value = params[name]
    if (value !== undefined) scoped[name] = value
  }
  return scoped
}

const EMPTY_LAYOUT_PARAMS: Record<string, string> = Object.freeze({})

export const EMPTY_RETAIN: ReadonlySet<number> = new Set<number>()

/**
 * Marks an error as coming from a LAYOUT loader, carrying that layout's id.
 *
 * The boundary that catches it must be at or above the failing layout's own segment. The route's
 * innermost `_error` may live BELOW the layout that failed, and rendering there would wrap the
 * boundary in a layout whose data never arrived - so the page would render inside a component that
 * threw. A registry symbol, matching the other cross-module brands here.
 */
const LAYOUT_ERROR_ID = Symbol.for("nifra.web.layout-error-id")

export const tagLayoutError = (err: unknown, layoutId: string): unknown => {
  if (typeof err === "object" && err !== null && !(LAYOUT_ERROR_ID in err)) {
    Object.defineProperty(err, LAYOUT_ERROR_ID, { value: layoutId, enumerable: false })
  }
  return err
}

export const layoutErrorId = (err: unknown): string | undefined =>
  typeof err === "object" && err !== null
    ? ((err as Record<symbol, unknown>)[LAYOUT_ERROR_ID] as string | undefined)
    : undefined

export const STATUS_SIGNAL = Symbol.for("nifra.web.status-signal")

/** Reason phrases for the plain-text fallback, used only when the app authored no `_<status>` and no
 * `_404` page. Deliberately not exhaustive - anything unlisted falls back to "Error", which is more
 * useful than shipping a table of every RFC status for a body almost nobody will see. */
export const STATUS_TEXT: Readonly<Record<number, string>> = {
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  410: "Gone",
  451: "Unavailable For Legal Reasons",
  500: "Internal Server Error",
}

export interface StatusSignal extends Response {
  readonly [STATUS_SIGNAL]: { readonly status: number; readonly headers?: HeadersLike }
}

export function isStatusSignal(value: unknown): value is StatusSignal {
  return value instanceof Response && STATUS_SIGNAL in value
}

function statusSignal(status: number, options: StatusPageOptions): never {
  if (!Number.isInteger(status) || status < 400 || status > 599) {
    throw new Error(
      `[nifra/web] statusPage(${JSON.stringify(status)}) must be an integer 4xx or 5xx status. Use redirect() for 3xx, and return data for a successful render.`,
    )
  }
  const response = new Response(null, { status })
  // Non-enumerable so the brand never lands in a structured clone or a JSON log of the response.
  Object.defineProperty(response, STATUS_SIGNAL, {
    value: { status, ...(options.headers !== undefined ? { headers: options.headers } : {}) },
    enumerable: false,
  })
  throw response
}

/** Options shared by {@link notFound}, {@link gone}, and {@link statusPage}. */
export interface StatusPageOptions {
  /**
   * Extra headers for the rendered response - `cache-control` above all.
   *
   * The defaults differ by status for a reason: a 404 may be a race with publication, so it wants a
   * short TTL, while a 410 is a promise that the URL is permanently gone and can be cached hard.
   * Getting this wrong is the difference between a crawler dropping a dead URL and re-fetching it
   * for weeks.
   */
  readonly headers?: HeadersLike
}

/**
 * Render the nearest `_404` page at status **404**. `throw` it from a loader when the record does not
 * exist.
 *
 * This is the fix for the soft 404: a matched route whose loader finds nothing has otherwise no way to
 * answer 404, so the path of least resistance is to return empty data and render "not found" inside a
 * **200**. That looks correct in a browser and is invisible in review, which is why it ships and stays
 * shipped - while search engines penalise it and keep the dead URL indexed.
 *
 * Returns `never`: these throw, so a loader narrows without a redundant `return`, and the type states
 * the thing the "loaders `throw` redirect, actions `return` it" rule already trips people on.
 */
export function notFound(options: StatusPageOptions = {}): never {
  return statusSignal(404, options)
}

/**
 * Render a terminal page at status **410 Gone**. `throw` it from a loader for a record that existed and
 * was deliberately removed - a withdrawn listing, a deleted post.
 *
 * 410 is not a pedantic 404: it tells a crawler to **drop** the URL rather than re-fetch it for weeks
 * on the assumption the 404 was transient. Uses `_410.tsx` if the app has one, otherwise `_404`.
 */
export function gone(options: StatusPageOptions = {}): never {
  return statusSignal(410, options)
}

/**
 * Render a terminal page at any 4xx/5xx status - the escape hatch behind {@link notFound} and
 * {@link gone} (402, 451, …). Uses `_<status>.tsx` if present, otherwise `_404`.
 */
export function statusPage(status: number, options: StatusPageOptions = {}): never {
  return statusSignal(status, options)
}

/** The wrapper `revalidate()` returns: the action's `data` plus the paths it changed. A plain tagged
 * shape (not a class) so `@nifrajs/client`'s `ActionData` can unwrap it structurally without importing
 * from `@nifrajs/web`. `createWebApp` strips the wrapper - the client receives `data` as the body and
 * the paths via the `X-Nifra-Revalidate` header. */
export interface RevalidateResult<T> {
  readonly __nifraRevalidate: readonly string[]
  readonly data: T
}

/**
 * Return this from an action to declare which routes the mutation changed (alongside the action's
 * `data`). `createWebApp` sets the `X-Nifra-Revalidate` response header; after the submit the client
 * marks those cached routes stale - refetching the active one and any mounted fetcher showing them -
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
  const serialized = JSON.stringify(data ?? null)
  // Most loader payloads contain no script-sensitive characters. Guard with chained `indexOf`
  // rather than a regex `.test`: each probe is a native memchr-style scan, measured ~7x faster than
  // the regex scan on V8 for a multi-KB payload (and the engine rejects the two >0xFF separator
  // probes in O(1) when the string is internally one-byte, which serialized JSON almost always is).
  // The same four characters are probed as the SCRIPT_ESCAPE class, so any payload the regex would
  // escape still takes the escape path - this is only a cheaper detector, never a security
  // relaxation.
  const needsEscape =
    serialized.indexOf("<") !== -1 ||
    serialized.indexOf(">") !== -1 ||
    serialized.indexOf(LINE_SEP) !== -1 ||
    serialized.indexOf(PARA_SEP) !== -1
  return needsEscape
    ? serialized.replace(SCRIPT_ESCAPE, (ch) => SCRIPT_ESCAPE_MAP[ch] ?? ch)
    : serialized
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

/**
 * Escape a `<script>` element's text content so it cannot break out of the element. Per the HTML spec,
 * a script's text may contain any character EXCEPT the sequences that the parser treats as element
 * boundaries: `</` (which would begin the end tag - `</script>` is the obvious XSS vector, but ANY `</`
 * starts script-data-end-tag parsing), and the comment/CDATA edges `<!--` / `]]>`. We escape the `<`
 * (and the `>` of `]]>`) to its JS unicode escape: inside a JS/JSON string literal `<` is the
 * identical character, so a JSON-LD payload is byte-equivalent after parsing - but the raw `<`/`>` the
 * HTML tokenizer scans for is gone. This is the JSON-LD-in-HTML rule (content is JSON, never raw HTML),
 * mirroring {@link serializeData}'s posture for the data-global script. Idempotent on already-safe text.
 */
function escapeScriptContent(content: string): string {
  // Order matters: rewrite `]]>` first (its `>` becomes `>`), then every `<` (covers `</` and
  // `<!--` in one pass). `<` → `<`; the lone `>` of `]]>` → `>`. A bare `>` elsewhere is
  // harmless in script data, so only the `]]>` close is targeted for `>`.
  return content.replaceAll("]]>", "]]\\u003e").replaceAll("<", "\\u003c")
}

function escapeAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}

/** Serialize attributes that passed the shared SSR/client head trust policy. */
function tagAttrs(tag: "meta" | "link", attrs: Readonly<object>): string | null {
  const trusted = trustedHeadAttributes(tag, attrs)
  if (trusted === null) return null
  let out = ""
  for (const [name, value] of trusted) {
    if (out !== "") out += " "
    out += value === true ? name : `${name}="${escapeAttr(value)}"`
  }
  return out
}

// Memoize the serialized head-tag string by the resolved `Meta` object's identity. A STATIC route
// `meta` is returned by-reference from resolveMeta, so the same object recurs every request → cache
// hit, and the invariant string is serialized once per route, not per request. Function results are
// never cached, even when a function deliberately reuses one mutable object across requests. WeakMap
// so a route module that's GC'd takes its entry with it.
const headTagsCache = new WeakMap<Meta, string>()

function assertExecutableScriptType(type: string): void {
  if (!EXECUTABLE_SCRIPT_TYPES.has(type)) {
    throw new TypeError(
      `[nifra/web] executable inline scripts accept ${[...EXECUTABLE_SCRIPT_TYPES].map((t) => JSON.stringify(t)).join(" or ")}; received ${JSON.stringify(type)}`,
    )
  }
}

/** Render a route's `meta`/`link`/`script` as managed (`data-nifra`) head tags. Title is set
 * separately. XSS-safe by construction: every attribute flows through the shared tag-specific trust
 * policy then value escaping, and each `script[].content` through `escapeScriptContent`
 * (breakout-escaped) - so loader-derived strings (LLM-authored `og:*`, user content) can't inject markup
 * or close the tag early. String concatenation (no intermediate `.map()` arrays + spread) - parity with
 * the already concat-based preloadLinks/styleLinks/islandPreloads loops; byte-identical output. Result
 * is memoized only for objects observed as static meta exports (serialized once per route). */
function headTags(head: Meta | undefined): string {
  if (head === undefined) return ""
  const cacheable = isStaticMeta(head)
  if (cacheable) {
    const cached = headTagsCache.get(head)
    if (cached !== undefined) return cached
  }
  let out = ""
  if (head.meta !== undefined)
    for (const m of head.meta) {
      const attrs = tagAttrs("meta", m)
      if (attrs !== null) out += `<meta${attrs === "" ? "" : ` ${attrs}`} data-nifra>`
    }
  if (head.link !== undefined)
    for (const l of head.link) {
      const attrs = tagAttrs("link", l)
      if (attrs !== null) out += `<link${attrs === "" ? "" : ` ${attrs}`} data-nifra>`
    }
  // `<script>` slot - JSON-LD + other inert head scripts. `type` is attribute-escaped; `content` is
  // breakout-escaped (`escapeScriptContent`) so a `</script>` (or `<!--`/`]]>`) payload can't close the
  // element early. Managed (`data-nifra`) so a soft-nav's `applyHead` cleanly replaces it.
  if (head.script !== undefined)
    for (const s of head.script) {
      const type = s.type ?? "application/ld+json"
      if (!INERT_SCRIPT_TYPES.has(type)) {
        throw new TypeError(
          `[nifra/web] head.script only accepts inert JSON script types; received ${JSON.stringify(type)}. Use unsafeInlineScript() with a CSP nonce for executable code.`,
        )
      }
      out += `<script type="${type}" data-nifra>${escapeScriptContent(s.content)}</script>`
    }
  if (head.unsafeScript !== undefined)
    for (const s of head.unsafeScript) {
      if (s.unsafe !== true || s.nonce.trim() === "") {
        throw new TypeError("[nifra/web] executable inline scripts require a non-empty CSP nonce")
      }
      // `type` is validated, not escaped, for the same reason as the inert slot above: an unknown
      // value here is a bug, and escaping one would emit a nonsense script type rather than say so.
      // It was interpolated raw while the `nonce` beside it was escaped, so a descriptor built by hand
      // - `unsafeScript` is a public field, the helper is only a convenience - could close the
      // attribute and inject markup. Measured: `type: '"><img src=x onerror=alert(1)>'` reached the
      // document. An injection in the slot whose whole purpose is to make script emission trustworthy.
      assertExecutableScriptType(s.type)
      out += `<script type="${s.type}" nonce="${escapeAttr(s.nonce)}" data-nifra>${escapeScriptContent(s.content)}</script>`
    }
  if (cacheable) headTagsCache.set(head, out)
  return out
}

/**
 * A `<link rel="canonical">` descriptor for a route's `meta.link`. The canonical URL tells search
 * engines which URL is authoritative for a page (deduping query-string / tracking variants).
 *
 * ```ts
 * export const meta = (a) => ({ link: [canonical(`https://site.com/posts/${a.params.slug}`)] })
 * ```
 */
export function canonical(href: string): LinkDescriptor {
  return { rel: "canonical", href }
}

/** Inputs for {@link openGraph} - the common Open Graph properties. All optional; only the provided
 * ones become tags. `type` defaults to `"website"`. */
export interface OpenGraphInput {
  readonly title?: string
  readonly description?: string
  /** Absolute URL of the share image (`og:image`). */
  readonly image?: string
  /** Canonical URL of the page (`og:url`). */
  readonly url?: string
  /** Object type (`og:type`) - `"website"`, `"article"`, … Default `"website"`. */
  readonly type?: string
}

/**
 * Build the Open Graph `<meta property="og:*">` entries for a route's `meta.meta`. Returns only the
 * properties you supplied (plus `og:type`, defaulting to `"website"`), so it composes with other meta.
 *
 * ```ts
 * export const meta = { meta: [...openGraph({ title: "Nifra", image: "https://site.com/og.png" })] }
 * ```
 */
export function openGraph(input: OpenGraphInput): MetaDescriptor[] {
  const tags: MetaDescriptor[] = []
  const add = (property: string, content: string | undefined): void => {
    if (content !== undefined) tags.push({ property, content })
  }
  add("og:title", input.title)
  add("og:description", input.description)
  add("og:image", input.image)
  add("og:url", input.url)
  // `og:type` always present (the spec's required property) - default "website" when unset.
  tags.push({ property: "og:type", content: input.type ?? "website" })
  return tags
}

/**
 * Build a JSON-LD `<script type="application/ld+json">` entry for a route's `meta.script` from a plain
 * object. `JSON.stringify` produces the body; the head renderer breakout-escapes it (see
 * `escapeScriptContent`), so a string field containing `</script>` is embedded safely.
 *
 * ```ts
 * export const meta = {
 *   script: [jsonLd({ "@context": "https://schema.org", "@type": "Article", headline: "Hi" })],
 * }
 * ```
 */
export function jsonLd(data: Record<string, unknown>): ScriptDescriptor {
  return { type: "application/ld+json", content: JSON.stringify(data) }
}

/**
 * Deliberately unsafe escape hatch for executable inline code. The required nonce keeps the result
 * compatible with a strict CSP and makes the security-sensitive choice visible at the call site.
 */
export function unsafeInlineScript(
  content: string,
  options: { readonly nonce: string; readonly type?: "module" | "text/javascript" },
): UnsafeScriptDescriptor {
  if (options.nonce.trim() === "") {
    throw new TypeError("[nifra/web] unsafeInlineScript requires a non-empty CSP nonce")
  }
  const type = options.type ?? "module"
  // Checked here as well as at emit: the type union is compile-time only, and this helper is the one
  // place a caller is told what it may pass. Failing at the call site names the argument; failing at
  // render names a document.
  assertExecutableScriptType(type)
  return {
    unsafe: true,
    type,
    nonce: options.nonce,
    content,
  }
}
