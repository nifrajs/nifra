/**
 * Framework-agnostic rendering protocol shared by the web runtime and every render adapter.
 *
 * This module is intentionally small and has no runtime dependencies. Keeping the protocol and the
 * dev SSR-loader singleton here lets adapters and conformance tests depend on the seam directly
 * without importing the document renderer through the root module. The singleton is stored on
 * globalThis because the Bun and Vite dev pipelines can evaluate two copies in one process.
 */

import type { BoundaryStates } from "./boundary.ts"
import type { Submission } from "./router.ts"

/** The data handed to a route component. */
export interface RenderProps {
  readonly serverComponents?: import("./server-components/types.ts").ComponentState
  readonly data: unknown
  /** Per-layout loader data, aligned index-for-index with the layout prefix of `chain`. */
  readonly layoutData?: readonly unknown[]
  readonly actionData?: unknown
  /** True while a client navigation or submit is in flight (client-only; absent/false on SSR). */
  readonly pending?: boolean
  /** The path a client navigation is transitioning TO while `pending` (client-only; absent on SSR). */
  readonly pendingPath?: string
  /** The in-flight client submit, for optimistic UI (client-only; absent on SSR). */
  readonly submission?: Submission
  /** The matched route's decoded path params. */
  readonly params?: Readonly<Record<string, string>>
  /** The current URL's `pathname + search` (no hash). */
  readonly path?: string
  /** The route's typed, validated search params. */
  readonly search?: Record<string, unknown>
  /** Neutral named-boundary states; adapters choose how each boundary's `render` UI is mounted. */
  readonly boundaries?: BoundaryStates
  /** The rendered chain's module ids and `handle` exports, for the adapter's `useMatches`. */
  readonly matchChain?: MatchChain
  /** The page's locale, when the app registers its locale routing (`createWebApp`'s `i18n`). Set on
   * SSR only; the client names it from `path` (see {@link localeOfProps}). */
  readonly locale?: PageLocale
}

/** A served locale as a page renders in it: from the app's locale registry. */
export interface PageLocale {
  /** The registry key, which is also the URL segment (`ur`). */
  readonly key: string
  /** The BCP-47 tag `<html lang>` and `Content-Language` carry (`ur-PK`). */
  readonly lang: string
  readonly dir: "ltr" | "rtl"
}

/** The served locales, handed to the client so it names a page's locale from its path the way the
 * server does. */
export interface PageLocales {
  /** The default locale's key. */
  readonly default: string
  /** Every served locale, in registry order. */
  readonly locales: readonly PageLocale[]
}

/** The handover global carrying {@link PageLocales}. */
export const LOCALES_GLOBAL = "__NIFRA_LOCALES__"

/**
 * The locale a path is in, by the rule `@nifrajs/i18n/routing`'s `localeOf` follows: a first path
 * segment that names a served locale, ignoring ASCII case, or else the default.
 */
export function pageLocaleIn(config: PageLocales, path: string): PageLocale | undefined {
  // One linear pass: separators, then the segment up to the next separator, query or hash.
  const first = /^[/\\]*([^/\\?#]*)/.exec(path.replace(/[\t\n\r]/g, ""))?.[1]?.toLowerCase()
  return (
    config.locales.find((locale) => first !== "" && locale.key.toLowerCase() === first) ??
    config.locales.find((locale) => locale.key === config.default)
  )
}

const isPageLocales = (value: unknown): value is PageLocales =>
  typeof value === "object" && value !== null && "locales" in value && Array.isArray(value.locales)

/** The locale of the page at `path`, from the served locales the server handed over; `undefined`
 * outside a browser page, or when the app registers no locale routing. */
export function handoverLocale(path: string): PageLocale | undefined {
  const config: unknown = Reflect.get(globalThis, LOCALES_GLOBAL)
  return isPageLocales(config) ? pageLocaleIn(config, path) : undefined
}

/** The locale of the page `props` render: the server's answer on SSR, else the one the client names
 * from `props.path`. What every adapter's `useLocale` reads. */
export function localeOfProps(props: RenderProps | undefined): PageLocale | undefined {
  if (props === undefined) return undefined
  if (props.locale !== undefined) return props.locale
  return props.path === undefined ? undefined : handoverLocale(props.path)
}

/**
 * The modules a render stacks, as `useMatches` needs them: each one's id and `handle` export,
 * outermost layout first and the page (or status page) last. Built by the server for SSR and by the
 * generated client entry per route, from the same manifest, so both sides report the same matches.
 */
export interface MatchChain {
  /** Layout ids (`orgs/[org]/_layout`), then the page's route id. */
  readonly ids: readonly string[]
  /** Each module's `handle` export, index-aligned with {@link ids}. */
  readonly handles: readonly unknown[]
}

/** One module of the rendered chain, as `useMatches` returns it. */
export interface UIMatch {
  /** The module's id: a layout's (`orgs/[org]/_layout`), or the page's route id last. */
  readonly id: string
  /** The part of the URL path this module wraps: a layout's directory prefix, the whole path for the
   * page. Raw, as it appears in the URL. */
  readonly pathname: string
  /** The params this module's loader receives: a layout's own, every route param for the page. */
  readonly params: Readonly<Record<string, string>>
  /** This module's loader data: `null` for a layout without a loader. */
  readonly data: unknown
  /** The module's `handle` export - any value, commonly a breadcrumb label or a render function. */
  readonly handle: unknown
}

/**
 * Markup a render produced for outside the app root, which an adapter that sets
 * {@link RenderAdapter.documentParts} appends to. Each part must be complete before the render
 * settles: `renderToString` resolving, or `renderToStream` returning its stream.
 */
export interface DocumentParts {
  /** Placed at the end of `<head>`. Svelte's `<svelte:head>` lands here. */
  head: string
  /** Placed first in `<body>`, before the app root. Vue's `<Teleport to="body">` lands here. */
  body: string
}

/** Per-document options for {@link RenderAdapter.renderToStream}. */
export interface RenderStreamOptions {
  /** The document's CSP nonce, for every executable `<script>` the framework streams. */
  readonly nonce?: string
  /** Present only for an adapter that sets {@link RenderAdapter.documentParts}. */
  readonly parts?: DocumentParts
  /**
   * Chain indices to render inside the two slot wrappers a kept page needs (`keepAlive`), each
   * `<slot data-nifra-entry><slot data-nifra-page>` around that chain entry (a `<slot>` lays out as
   * `display: contents`), so the browser's keep-alive view hydrates the same markup. Present only
   * in an app with a `keepAlive` route; an adapter without keep-alive support ignores it.
   */
  readonly slots?: readonly number[]
}

/**
 * The seam every render adapter implements. New adapters should prove these invariants with
 * `assertRenderAdapterConformance`; framework-specific behavior remains locally tested.
 */
export interface RenderAdapter {
  /**
   * Render a route's layout `chain` (outermost layout → page) to a Web stream of HTML bytes,
   * including the framework's hydration markers. When `options.nonce` is set, every executable
   * `<script>` the framework streams (out-of-order Suspense runtimes, serialized resources) must
   * carry it, or a nonce-based Content-Security-Policy blocks it and the boundary never resolves.
   */
  renderToStream(
    chain: readonly unknown[],
    props: RenderProps,
    options?: RenderStreamOptions,
  ): ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>
  /**
   * Render the chain to a complete HTML string when no content is deferred. `options.nonce` is the
   * document's CSP nonce, for any inline script the renderer emits (Solid's hydration data); a
   * document that sends a policy keeps the nonce only when the returned HTML carries it. Return
   * `undefined` when the render suspended on something only `renderToStream` waits for (React's
   * `use` or `lazy` inside `<Suspense>`): the page is then streamed instead.
   */
  renderToString?(
    chain: readonly unknown[],
    props: RenderProps,
    options?: RenderStreamOptions,
  ): string | undefined | Promise<string | undefined>
  /** Per-document bootstrap markup injected into `<head>` for client hydration. */
  hydrationHead(nonce?: string): string
  /**
   * Render one piece of UI (a boundary's `render` result or `fallback`) to an HTML string on its own,
   * outside the route chain. `ui` produces it: call it inside the render, since a framework whose
   * markup is made as it is evaluated (Solid) needs its render context there. `idPrefix` namespaces
   * any ids the framework generates, so two fragments rendered separately never collide. `hydrates`
   * is set when the client hydrates the fragment as a root of its own (an interactive hole). Required
   * for partial prerendering; optional otherwise.
   */
  renderFragment?(
    ui: () => unknown,
    options: { readonly idPrefix?: string; readonly hydrates?: boolean },
  ): string | Promise<string>
  /**
   * Set when a render can produce markup that belongs outside the app root. Every render is then
   * passed `options.parts` to fill; an adapter without it never is, and pays nothing for the seam.
   */
  readonly documentParts?: boolean
  /**
   * Render the chain and return only the HTML of the slot named `name`, or `undefined` when the
   * render has no such slot. Called for an {@link SWAP_HEADER} request; an adapter without it, or a
   * render without the slot, answers with the whole document, which the client loads normally.
   */
  renderSlot?(
    chain: readonly unknown[],
    props: RenderProps,
    name: string,
  ): string | undefined | Promise<string | undefined>
}

/**
 * Request header of a `data-swap` link or form: the name of the slot it refreshes. A response that
 * carries only that slot echoes it; any other response is a whole document.
 */
export const SWAP_HEADER = "x-nifra-swap"

/** Loads a module through the dev server's module graph rather than the runtime's resolver. */
export type SsrModuleLoader = (id: string) => Promise<unknown>

const SSR_MODULE_LOADER_SLOT = Symbol.for("nifra.web.ssr-module-loader")
const loaderSlot = globalThis as { [SSR_MODULE_LOADER_SLOT]?: SsrModuleLoader | undefined }

/** Publish or clear the dev server's SSR module loader. */
export function setSsrModuleLoader(load: SsrModuleLoader | undefined): void {
  loaderSlot[SSR_MODULE_LOADER_SLOT] = load
}

/** Return the dev server's SSR module loader, when one owns SSR resolution. */
export function ssrModuleLoader(): SsrModuleLoader | undefined {
  return loaderSlot[SSR_MODULE_LOADER_SLOT]
}

/**
 * `id` of the inert `<script type="application/json">` a hydrating document hands its page state over
 * in: one JSON object keyed by the `*_GLOBAL` names below, which the client entry assigns onto
 * `window` before anything reads them. Data the browser never executes needs no CSP nonce or hash.
 */
export const HANDOVER_ID = "__nifra-handover"

/** Global the server serializes loader data into; the client reads it to hydrate. */
export const DATA_GLOBAL = "__NIFRA_DATA__"
/** Per-layout loader data for hydration. */
export const LAYOUT_DATA_GLOBAL = "__NIFRA_LAYOUT_DATA__"
/** Global the server writes the matched route id into. */
export const ROUTE_GLOBAL = "__NIFRA_ROUTE__"
/** Global the server serializes an action's data return into (absent on GETs); the client reads it
 * so hydration after a native form POST matches the server-rendered markup. */
export const ACTION_GLOBAL = "__NIFRA_ACTION__"
/** Dynamic-boundary states for hydration; absent when a route declares no boundaries. */
export const BOUNDARY_GLOBAL = "__NIFRA_BOUNDARIES__"
export const COMPONENT_GLOBAL = "__NIFRA_COMPONENTS__"
/** Locale key -> copy chunk URL, in a production build that split copy tables by locale. The name
 * `@nifrajs/i18n/copy` reads. */
export const COPY_CHUNKS_GLOBAL = "__NIFRA_COPY__"
/** The registry `@nifrajs/i18n/copy` keeps its loaded chunks and definitions in. */
export const COPY_REALM = "nifra.copy"
/** Marker attribute used to find a non-default hydration container. */
export const ROOT_ATTRIBUTE = "data-nifra-root"
