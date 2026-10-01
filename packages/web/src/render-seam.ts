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

/** Per-document options for {@link RenderAdapter.renderToStream}. */
export interface RenderStreamOptions {
  /** The document's CSP nonce, for every executable `<script>` the framework streams. */
  readonly nonce?: string
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
  /** Render the chain to a complete HTML string when no content is deferred. */
  renderToString?(chain: readonly unknown[], props: RenderProps): string | Promise<string>
  /** Per-document bootstrap markup injected into `<head>` for client hydration. */
  hydrationHead(nonce?: string): string
}

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
/** Marker attribute used to find a non-default hydration container. */
export const ROOT_ATTRIBUTE = "data-nifra-root"
