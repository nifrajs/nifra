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
  DEFAULT_DEV_PORT,
  PRE_HYDRATION_GUARD,
  type ServerOnly,
} from "./internal/runtime-contract.ts"
/**
 * The two file-name conventions that decide what never reaches a browser: a `*.server` module is
 * EMPTIED in the client build, a `*.fn` module is REPLACED with client stubs.
 *
 * Exported because more than the bundlers need them. `nifra dev --bun` cannot transform (Bun's dev
 * bundler takes no plugins) so it must REFUSE instead, and a refusal driven by its own hand-written
 * glob drifts from the transform - which is how `.fn.mts` came to be stubbed by both build pipelines
 * and waved through by the guard that exists to stop it leaking. Anything deciding "is this module
 * server-only" should import the matcher rather than re-encode it.
 */
export { SERVER_FN_MODULE, SERVER_ONLY_MODULE } from "./internal/server-boundary.ts"
export {
  type CreateWebAppOptions,
  createWebApp,
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
  type Manifest,
  type Meta,
  type MetaArgs,
  type MetaDescriptor,
  type MetaInput,
  type RouteEntry,
  type RouteModule,
  type ScriptDescriptor,
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
  type RouteSearch,
  registerBlocker,
  resolveNavigate,
  setBlockerController,
  setBrowserNavigate,
} from "./navigation.ts"
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
  LAYOUT_DATA_GLOBAL,
  type RenderAdapter,
  type RenderProps,
  ROOT_ATTRIBUTE,
  ROUTE_GLOBAL,
  type SsrModuleLoader,
  setSsrModuleLoader,
  ssrModuleLoader,
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
