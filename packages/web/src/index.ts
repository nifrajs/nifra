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
  type SharedBoundary,
  type SharedHoleCtx,
  type ShellCtx,
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
// Generated client entries intentionally import the browser router from the client subpath:
// `import { createClientRouter, createMatcher, mergeHeads, resolveChainMeta } from "@nifrajs/web/client"`.
export {
  type BuildAssetSet,
  createHostPolicy,
  type HostPolicy,
  type HostPolicyOptions,
  type HostPolicyRule,
  isHostPolicy,
} from "./host-policy.ts"
export {
  type GenerateClientEntryOptions,
  type GenerateServerManifestOptions,
  generateClientEntry,
  generateServerManifest,
  type LiveClientEntry,
} from "./internal/codegen.ts"
export { mergeHeads, resolveChainMeta, resolveMeta } from "./internal/head-merge.ts"
// The server half of the identity epoch that drops kept pages on a sign-in or sign-out.
export {
  type IdentityEpochContext,
  type KeepAliveServerOptions,
  rotateIdentityEpoch,
} from "./internal/identity-epoch.ts"
export type { PrerenderedPages } from "./internal/prerendered-pages.ts"
export {
  type RedirectOptions,
  type RenderAssemblyCache,
  type RenderedPage,
  type RenderPageInput,
  type RenderPageOptions,
  type RevalidateOptions,
  type RevalidateResult,
  redirect,
  renderPage,
  renderPageResult,
  revalidate,
  serializeData,
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
export { gone, notFound, type StatusPageOptions, statusPage } from "./internal/status-page.ts"
export {
  type CreateWebAppOptions,
  createWebApp,
  type NonceResolver,
  type WebAppI18n,
  webProjectEvidence,
} from "./internal/web-app.ts"
// ISR (incremental static regeneration): a pluggable cache store + the `withISR` stale-while-revalidate
// wrapper for rendered SSR responses.
export {
  type CachedResponse,
  type CacheStore,
  type CdnPurgeOutcome,
  type CdnPurgeTarget,
  ISR_REVALIDATE_HEADER,
  ISR_REVALIDATE_TAGS_HEADER,
  ISR_STATUS_HEADER,
  type ISRApp,
  type ISROptions,
  type ISRPlatform,
  type ISRQuery,
  type ISRStoreOp,
  isCacheablePage,
  KVCacheStore,
  type KVCacheStoreOptions,
  type KVNamespaceLike,
  MemoryCacheStore,
  type MemoryCacheStoreOptions,
  type RevalidateEndpointOptions,
  type RevalidateTags,
  type RevalidateTagsInput,
  revalidateEndpoint,
  withISR,
} from "./isr.ts"
// File-based routing manifest - pure + fs-free. `discoverRoutes` (fs) lives in `@nifrajs/web/fs`.
export {
  type Action,
  type BoundaryLoaderEntry,
  type BoundaryLoadersOf,
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
  type KeepAliveOptions,
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
  closeBoundary,
  getBrowserNavigate,
  type Href,
  IDLE_BLOCKER,
  type NavigateFunction,
  type NavigateOptions,
  type NavigateSearchOf,
  type NavigateTargetInput,
  type PrefetchMode,
  type RouteTable,
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
// public/ - user-authored static files; `@nifrajs/core/serve-static` serves them on Bun.
export {
  type PrerenderedPageReaderOptions,
  prerenderedPageReader,
  resolvePublicPath,
} from "./public-dir.ts"
// Keyed query-cache (agnostic) - a `query(key, fn)` primitive (dedup + staleness + invalidation + GC)
// consumed by the per-adapter `useQuery`/`createQuery` bindings.
export {
  createMutation,
  createQueryClient,
  type DehydratedQueryInfo,
  type DehydratedState,
  type DehydrateOptions,
  hashQueryKey,
  type InfiniteData,
  type InfiniteQueryHandle,
  type InfiniteQueryOptions,
  type MutationCallbacks,
  MutationCancelledError,
  type MutationContext,
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
  type DocumentParts,
  HANDOVER_ID,
  LAYOUT_DATA_GLOBAL,
  LOCALES_GLOBAL,
  localeOfProps,
  type MatchChain,
  type PageLocale,
  type PageLocales,
  pageLocaleIn,
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
  type DataText,
  type Fetcher,
  type FetcherState,
  type FetchRouteData,
  type Intercepted,
  type KeptPage,
  type MountRouterOptions,
  NAV_FROM_HEADER,
  PREFETCH_HEADER,
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
export { canonical, jsonLd, type OpenGraphInput, openGraph } from "./seo.ts"
export {
  type HtmlSanitizer,
  type SanitizedHtml,
  sanitizedHtml,
  sanitizeHtml,
  type TrustedHtml,
  trustHtml,
} from "./trusted-html.ts"
