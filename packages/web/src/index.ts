/**
 * @nifrajs/web - the framework-agnostic SSR core. It owns the render *seam* and the HTML
 * document orchestration, and knows nothing about any specific UI framework: a render
 * adapter (@nifrajs/web-solid, @nifrajs/web-react, …) supplies the actual render + hydrate.
 *
 * The core treats a "component" and a hydration "container" as opaque `unknown` - only
 * the adapter interprets them. That keeps this package both framework-agnostic and free
 * of DOM types: it is pure server orchestration + string building.
 */

// Draft / preview mode - a signed cookie that flips `ctx.draft` for loaders + bypasses ISR for editors.
export {
  assertStaticBoundaryImports,
  type Boundary,
  type BoundaryDescriptor,
  type BoundaryError,
  type BoundaryMode,
  type BoundaryRegistration,
  type BoundaryRequestCtx,
  type BoundaryState,
  type BoundaryStates,
  type BoundaryStatus,
  boundaryDescriptors,
  boundaryModeKey,
  type DynamicBoundary,
  type DynamicBoundaryBatch,
  type InterceptBoundary,
  MemoryStaticBoundaryCache,
  type PendingBoundary,
  resolveDynamicBoundaries,
  resolveStaticBoundaries,
  type StaticBoundary,
  type StaticBoundaryCache,
  type StaticBoundaryImportEdge,
  type StaticBoundaryRoot,
  type StaticCtx,
  startDynamicBoundaries,
} from "./boundary.ts"
export {
  assertRenderAdapterConformance,
  RenderAdapterConformanceError,
  type RenderAdapterConformanceFixture,
} from "./conformance.ts"
// Hash-based CSP: a document carries a nonce only when it needs one, so a CSP page stays cacheable.
export {
  type CreateCspPolicyOptions,
  type CspHeaderContext,
  type CspPolicy,
  createCspPolicy,
  nifraScriptHashes,
} from "./csp.ts"
export {
  assertCssLoadingCompatible,
  type CssLoadingMode,
  DEFAULT_CSS_LOADING,
  normalizeCssLoading,
} from "./css-contract.ts"
// Deferred loader data (`defer()` + the `Deferred<T>` type) - consumed by the adapter's `<Await>`.
export { type Deferred, defer } from "./deferred.ts"
export {
  DRAFT_COOKIE,
  type DraftCookieControls,
  disableDraft,
  type EnableDraftOptions,
  enableDraft,
  isDraftEnabled,
  type PreviewEndpointOptions,
  previewEndpoint,
} from "./draft.ts"
// Font optimization - a CLS-safe `@font-face` generator + a preload `<link>` for self-hosted fonts.
export {
  type FontDisplay,
  type FontFace,
  type FontPreloadInput,
  type FontSource,
  fontFace,
  fontPreload,
} from "./fonts.ts"
export {
  type GenerateClientEntryOptions,
  type GenerateRouteSearchTypesOptions,
  type GenerateServerManifestOptions,
  generateClientEntry,
  generateRouteSearchTypes,
  generateServerManifest,
} from "./internal/codegen.ts"
// Generated client entries intentionally import the browser router from the client subpath:
// `import { createClientRouter, createMatcher, mergeHeads, resolveMeta } from "@nifrajs/web/client"`.
export { mergeHeads, resolveMeta } from "./internal/head-merge.ts"
export {
  canonical,
  gone,
  jsonLd,
  notFound,
  type OpenGraphInput,
  openGraph,
  type RedirectOptions,
  type RenderAssemblyCache,
  type RenderedPage,
  type RenderPageInput,
  type RenderPageOptions,
  type RevalidateResult,
  redirect,
  renderPage,
  renderPageResult,
  revalidate,
  type StatusPageOptions,
  serializeData,
  statusPage,
  unsafeInlineScript,
} from "./internal/render-document.ts"
export {
  type BackendOnly,
  DEFAULT_DEV_PORT,
  PRE_HYDRATION_GUARD,
} from "./internal/runtime-contract.ts"
/**
 * The `*.fn` server-function convention: the browser build REPLACES such a module with client stubs.
 * Exported so anything deciding "is this a server-function module" imports the matcher instead of
 * re-encoding it - a hand-written glob drifts from the transform, which is how `.fn.mts` was once
 * stubbed by both build pipelines and waved through by the guard meant to stop it leaking.
 */
export { SERVER_FN_MODULE } from "./internal/server-boundary.ts"
export {
  type CreateWebAppOptions,
  createWebApp,
  type NonceResolver,
  webProjectEvidence,
} from "./internal/web-app.ts"
// ISR (incremental static regeneration): a pluggable cache store + the `withISR` stale-while-revalidate
// wrapper for rendered SSR responses.
export {
  type CachedResponse,
  type CacheStore,
  ISR_REVALIDATE_HEADER,
  ISR_REVALIDATE_TAGS_HEADER,
  ISR_STATUS_HEADER,
  type ISRApp,
  type ISROptions,
  type ISRPlatform,
  type ISRQuery,
  KVCacheStore,
  type KVCacheStoreOptions,
  type KVNamespaceLike,
  MemoryCacheStore,
  type MemoryCacheStoreOptions,
  type RevalidateEndpointOptions,
  revalidateEndpoint,
  withISR,
} from "./isr.ts"
// File-based routing manifest - pure + fs-free. `discoverRoutes` (fs) lives in `@nifrajs/web/fs`.
export {
  type Action,
  buildManifest,
  type ClientAction,
  type ClientActionArgs,
  type ClientActionResult,
  type ClientLoader,
  type ClientLoaderArgs,
  type ClientRequestBody,
  type ClientRouteHooks,
  enumerateStaticRoutes,
  filePathToPattern,
  filePathToPatterns,
  type GetStaticPaths,
  type InertScriptType,
  type LayoutEntry,
  type LinkDescriptor,
  type Loader,
  type LoaderContext,
  type LoaderResponseControls,
  type LoadingEntry,
  type Manifest,
  type Meta,
  type MetaArgs,
  type MetaDescriptor,
  type MetaInput,
  type MiddlewareOutcome,
  type NotFoundEntry,
  type NotFoundScope,
  type RouteEntry,
  type RouteMiddleware,
  type RouteModule,
  type ScriptDescriptor,
  type ShouldRevalidate,
  type ShouldRevalidateArgs,
  type StaticPath,
  type StaticPaths,
  type StaticRoutes,
  type UnsafeScriptDescriptor,
} from "./manifest.ts"
// Navigation bridge - a DOM-free seam the browser layer (`installHistory`) populates so an adapter's
// `useNavigate` (a route component, importing only this agnostic entry) reaches history-aware nav.
export {
  type Blocker,
  type BlockerController,
  type BlockerFunction,
  type BlockerLocation,
  type BlockerState,
  type BrowserNavigate,
  getBrowserNavigate,
  IDLE_BLOCKER,
  type NavigateFunction,
  type NavigateOptions,
  type NavigateSearchOf,
  type NavigateTargetInput,
  type PrefetchMode,
  type RouteSearch,
  registerBlocker,
  resolveNavigate,
  setBlockerController,
  setBrowserNavigate,
} from "./navigation.ts"
export {
  type CreateNonceResolverOptions,
  createNonceResolver,
  type NonceContext,
  type NonceGenerator,
  type NonceHeader,
  type NonceHeaderContext,
} from "./nonce.ts"
// public/ - user-authored static files, served identically in dev and production by one handler.
export {
  type PublicDirCache,
  resolvePublicPath,
  type ServePublicDirOptions,
  servePublicDir,
} from "./public-dir.ts"
// Keyed query-cache (agnostic) - a `query(key, fn)` primitive (dedup + staleness + invalidation + GC)
// consumed by the per-adapter `useQuery`/`createQuery` bindings.
export {
  createMutation,
  createQueryClient,
  type DehydratedState,
  hashQueryKey,
  type InfiniteData,
  type InfiniteQueryHandle,
  type InfiniteQueryOptions,
  type MutationCallbacks,
  type MutationHandle,
  type MutationState,
  type MutationStatus,
  type QueryClient,
  type QueryClientOptions,
  type QueryHandle,
  type QueryOptions,
  type QueryState,
  type QueryStatus,
} from "./query.ts"
export {
  ACTION_GLOBAL,
  BOUNDARY_GLOBAL,
  DATA_GLOBAL,
  HANDOVER_ID,
  LAYOUT_DATA_GLOBAL,
  type MatchChain,
  type RenderAdapter,
  type RenderProps,
  type RenderStreamOptions,
  ROOT_ATTRIBUTE,
  ROUTE_GLOBAL,
  type SsrModuleLoader,
  setSsrModuleLoader,
  ssrModuleLoader,
  type UIMatch,
} from "./render-seam.ts"
// Agnostic client-side router core (pure + DOM-free) - consumed by per-adapter Router bindings.
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
  NAV_FROM_HEADER,
  REDIRECT_HEADER,
  RETAIN_HEADER,
  REVALIDATE_HEADER,
  type RouteMatch,
  type RoutePattern,
  type RouterState,
  STATUS_HEADER,
  type Submission,
  type SubmitOptions,
} from "./router.ts"
// The search-derivation primitive: parse a URL query, validate it against a route's `searchSchema`
// (fail-closed to defaults), or return the raw parsed query when there is none. Both the server (loader
// ctx + `renderPage`) and a client adapter mount call this with the same URL + schema, so the two sides
// produce the identical value by construction. An adapter's `useSearch` binding reads its result.
export { type SearchOf, searchOf, searchOfChain, serializeSearch } from "./search.ts"
export {
  type HtmlSanitizer,
  type SanitizedHtml,
  sanitizedHtml,
  sanitizeHtml,
  type TrustedHtml,
  trustHtml,
} from "./trusted-html.ts"
