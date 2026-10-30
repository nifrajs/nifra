import { type CssLoadingMode, DEFAULT_CSS_LOADING, normalizeCssLoading } from "../css-contract.ts"
import { MAP_DEFERRED_SOURCE } from "../deferred.ts"
import type { LayoutEntry, Manifest } from "../manifest.ts"
import {
  ACTION_GLOBAL,
  BOUNDARY_GLOBAL,
  COMPONENT_GLOBAL,
  COPY_CHUNKS_GLOBAL,
  COPY_REALM,
  DATA_GLOBAL,
  HANDOVER_ID,
  LAYOUT_DATA_GLOBAL,
  LIVE_GLOBAL,
  LOCALES_GLOBAL,
  ROOT_ATTRIBUTE,
  ROUTE_GLOBAL,
} from "../render-seam.ts"
import { PRERENDERED_GLOBAL } from "../router.ts"
import { jsStringLiteral, jsValueLiteral } from "./js-string.ts"
import { keepAliveTable } from "./keep-alive-table.ts"

/** The refusal for a server build given no client entry, shared by the codegen and `buildServer`. */
export function missingClientEntry(clientEntry: unknown): TypeError {
  return new TypeError(
    `[nifra/web] the server build needs the client build: pass client (the manifest buildClient returned) or clientEntry (its entry URL), got clientEntry ${clientEntry === null ? "null" : typeof clientEntry}; pass clientEntry "" for an app with no client script`,
  )
}

/** The globals the page-state handover may set - nothing else in it reaches `window`. */
const HANDOVER_GLOBALS = [
  DATA_GLOBAL,
  LAYOUT_DATA_GLOBAL,
  ROUTE_GLOBAL,
  ACTION_GLOBAL,
  BOUNDARY_GLOBAL,
  COMPONENT_GLOBAL,
  PRERENDERED_GLOBAL,
  LOCALES_GLOBAL,
]
export interface GenerateClientEntryOptions {
  /**
   * Module specifier for the adapter's client runtime, e.g. `"@nifrajs/web-solid/client"`.
   *
   * **Contract:** the module MUST export `mountRouter({ router, routes, container })`. The generated
   * bootstrap imports the specifier and calls it - so a self-executing entry that mounts on import
   * builds cleanly and then does nothing, which is the trap this contract exists to name. The type is
   * a bare `string` because a specifier is resolved by the bundler, not the type system, so the
   * requirement is enforced by the bootstrap instead: it throws immediately, naming this module and
   * the missing export, rather than failing later as `mountRouter is not a function`.
   */
  readonly clientModule: string
  /** Turn a route/layout source file (relative to the routes dir) into an import specifier. */
  readonly resolve: (file: string) => string
  readonly serverComponents?: boolean
  /** The build moved copy tables into per-locale chunks: the handover carries the chunk URLs, and a
   * navigation loads the copy of the URL it goes to beside the route's code. */
  readonly copyChunks?: boolean
  /**
   * The server runs `createWebApp({ live })`: route loads go through its live load endpoint and the
   * entry keeps what is on screen fresh (`@nifrajs/web/live-client`). Absent, the entry is exactly the
   * non-live one.
   */
  readonly live?: LiveClientEntry | undefined
}

// The router as the entry names it: in a keep-alive app, the keep-alive layer over `router`.
const keepAround = (keep: unknown, router: string): string =>
  keep === undefined ? `const router = ${router}` : `const router = __keep.attach(${router})`

/** A client entry for a live server: `{}`, or the endpoints when the runtime moves them. */
export interface LiveClientEntry {
  readonly path?: string
  readonly loadPath?: string
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
/** The client modules whose package has a keep-alive mount beside them, at `<package>/keep-alive`. */
const KEEP_ALIVE_ADAPTERS: readonly string[] = [
  "@nifrajs/web-react/client",
  "@nifrajs/web-svelte/client",
  "@nifrajs/web-preact/client",
  "@nifrajs/web-solid/client",
  "@nifrajs/web-vue/client",
]

export function generateClientEntry(
  manifest: Manifest,
  options: GenerateClientEntryOptions,
): string {
  const { resolve } = options
  const keep = keepAliveTable(manifest)
  if (keep !== undefined && !KEEP_ALIVE_ADAPTERS.includes(options.clientModule)) {
    throw new Error(
      `[nifra/web] ${keep.routes.map((id) => `"${id}"`).join(", ")} export keepAlive, which needs the React, Preact, Solid, Svelte or Vue adapter; this app's client module is ${jsStringLiteral(options.clientModule)}. Remove the keepAlive export or switch the adapter.`,
    )
  }
  // A keep-alive app mounts through the adapter's keep-alive module, which re-exports its client.
  const clientModule =
    keep === undefined
      ? options.clientModule
      : options.clientModule.replace(/\/client$/, "/keep-alive")

  const loaderRows: string[] = []
  const patternRows: string[] = []
  const statusRoutes: Record<number, string> = {}
  // Routes whose loader appends a nearest `_error` module (LAST) - the client wraps the page in the
  // adapter's `errorBoundary(fallback)` for these, so a client render error shows the `_error` UI.
  const errorRouteIds: string[] = []
  // Route id → its layout ids, for the chain `useMatches` reports. Routes without layouts are omitted.
  const layoutIdsOf: Record<string, readonly string[]> = {}
  // Lazy loader returns the raw modules (for both the component chain + the page's `meta` export).
  const lazyLoader = (files: readonly string[]): string => {
    const imports = files.map((f) => `import(${jsStringLiteral(resolve(f))})`).join(", ")
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
    loaderRows.push(`  ${jsStringLiteral(route.id)}: ${lazyLoader(files)},`)
    if (route.layoutIds.length > 0) layoutIdsOf[route.id] = route.layoutIds
    patternRows.push(
      `  { routeId: ${jsStringLiteral(route.id)}, pattern: ${jsStringLiteral(route.pattern)} },`,
    )
  }
  // A root status page renders inside the root layout unless it exports `inLayouts = false`, which
  // only its module says - so the layout loads after the page, and only for a page that does not opt out.
  const rootLayout = manifest.layouts._layout
  const statusLoader = (routeId: string, file: string): string =>
    rootLayout === undefined
      ? lazyLoader([file])
      : `() => import(${jsStringLiteral(resolve(file))}).then((page) => withRootLayout(${jsStringLiteral(routeId)}, page))`
  if (manifest.notFound !== undefined) {
    loaderRows.push(`  "_404": ${statusLoader("_404", manifest.notFound.file)},`)
    statusRoutes[404] = "_404"
  }
  for (const [status, entry] of Object.entries(manifest.statusPages ?? {})) {
    const routeId = `_${status}`
    loaderRows.push(`  ${jsStringLiteral(routeId)}: ${statusLoader(routeId, entry.file)},`)
    statusRoutes[Number(status)] = routeId
  }
  const layoutStatusLines =
    rootLayout === undefined || Object.keys(statusRoutes).length === 0
      ? []
      : [
          "const layoutStatusRoutes = {}",
          "const withRootLayout = (id, page) => {",
          "  if (page.inLayouts === false) return [page]",
          `  return import(${jsStringLiteral(resolve(rootLayout.file))}).then((layout) => {`,
          "    layoutStatusRoutes[id] = true",
          '    layoutIdsOf[id] = ["_layout"]',
          "    return [layout, page]",
          "  })",
          "}",
        ]
  const routerStatusOption = layoutStatusLines.length === 0 ? "" : ", layoutStatusRoutes"
  // `_loading` pages. Emitted only when the app has one, so an app without them imports nothing extra.
  // Each is its own lazy chunk; a route row carries its layout ids and the loading pages above it with
  // the number of those layouts each sits under - all the runtime needs to choose one.
  const loadings = Object.entries(manifest.loadings ?? {})
  const loadingLines: string[] = []
  if (loadings.length > 0) {
    const routeRows = new Map<string, string>()
    for (const route of manifest.routes) {
      const above = (route.loadingIds ?? []).map((id) => [
        id,
        manifest.loadings?.[id]?.layoutIds.length ?? 0,
      ])
      routeRows.set(
        route.id,
        `  ${jsStringLiteral(route.id)}: ${jsValueLiteral([route.layoutIds, above])},`,
      )
    }
    loadingLines.push(
      "const loadingModules = {",
      ...loadings.map(
        ([id, entry]) =>
          `  ${jsStringLiteral(id)}: () => import(${jsStringLiteral(resolve(entry.file))}),`,
      ),
      "}",
      "const loadingRoutes = {",
      ...routeRows.values(),
      "}",
    )
  }

  const live = options.live
  const liveFetch =
    keep !== undefined
      ? ", fetchData: __keep.fetchData"
      : live === undefined
        ? ""
        : ", fetchData: __live.fetchData"
  return `${[
    // `/client`, never the root: the root's graph carries the server (renderPage, the static-file
    // server), and Vite's dev server evaluates what it is given instead of tree-shaking it.
    'import { createClientRouter, createMatcher, mergeHeads, resolveChainMeta } from "@nifrajs/web/client"',
    'import { applyHead, currentDocumentNonce, installForms, installHistory, signalHydrated, waitForStyles } from "@nifrajs/web/client"',
    ...(options.serverComponents
      ? ['import { bindComponentRouter } from "@nifrajs/web/server-components/client"']
      : []),
    ...(live === undefined ? [] : ['import { liveClient } from "@nifrajs/web/live-client"']),
    ...(keep === undefined ? [] : ['import { keepAliveClient } from "@nifrajs/web/keep-alive"']),
    // Namespace import: `errorBoundary` is optional (an adapter may not export it). A namespace member
    // access yields `undefined` if absent - unlike a named import, which would be a link error.
    ...(loadings.length > 0
      ? ['import { withLoading } from "@nifrajs/web/internal/loading-runtime"']
      : []),
    `import * as __adapter from ${jsStringLiteral(clientModule)}`,
    "const { mountRouter } = __adapter",
    // The assurance hook is optional: ordinary client entries pay only for the namespace lookup, while
    // hydration runners get a runtime identity from the exact adapter module that mounted the page. The
    // registry is token-only and lives on a Symbol.for key so it cannot collide with app data.
    "const __hydrationHook = __adapter.hydrationAssuranceHook",
    'if (__hydrationHook && typeof __hydrationHook.runtimeIdentity === "function") {',
    '  const __runtimeKey = Symbol.for("nifra.hydration.runtime")',
    "  const __runtimeState = globalThis[__runtimeKey]",
    "  const __identities = __runtimeState && Array.isArray(__runtimeState.identities) ? __runtimeState.identities : []",
    "  globalThis[__runtimeKey] = { framework: __hydrationHook.framework, identities: [...__identities, __hydrationHook.runtimeIdentity()] }",
    "}",
    // The `clientModule` contract is a string specifier, so nothing type-checks that the module it
    // names actually exports `mountRouter`. Without this the miss surfaces as
    // "mountRouter is not a function" from inside a bundled chunk, at first paint, naming neither the
    // module nor the requirement - a self-executing entry passes every build and fails only here.
    `if (typeof mountRouter !== "function") throw new Error(${jsValueLiteral(
      `[nifra/web] clientModule ${jsStringLiteral(clientModule)} does not export \`mountRouter\`. ` +
        "A client module must export `mountRouter({ router, routes, container })` - it is called by " +
        "the generated bootstrap, so a self-executing entry will not work. Use your adapter's " +
        '`/client` entry (e.g. "@nifrajs/web-react/client"), or re-export mountRouter from it.',
    )})`,
    "const errorBoundary = __adapter.errorBoundary",
    // A hot update that the framework cannot actually apply must end in a reload, not in nothing.
    //
    // Bun's dev server applies React Fast Refresh to JSX modules. For React that patches the component
    // and preserves state. For Preact it does not - the module still LOOKS Fast-Refresh-able, so the
    // update is accepted and then swallowed: `bun:beforeUpdate`/`bun:afterUpdate` both fire, the server
    // logs a rebuild, and the page silently keeps rendering the old code. An edit that appears to do
    // nothing is the worst failure mode in a dev loop - worse than a reload, because there is no signal
    // to act on. An adapter that knows its framework is in that position says so, and the entry turns
    // the swallowed update into an honest full reload.
    'if (import.meta.hot && __adapter.hotUpdateNeedsReload) import.meta.hot.on("bun:afterUpdate", () => location.reload())',
    `const errorRouteIds = new Set(${jsValueLiteral(errorRouteIds)})`,
    // Each route is a lazy loader: dynamic imports → Bun.build (splitting) emits one chunk per
    // route, shared layouts/deps deduped into shared chunks, so a route's code loads only when
    // visited. loadModule caches the [layouts…, page] component chain + the chain's meta list per id.
    ...layoutStatusLines,
    "const loaders = {",
    ...loaderRows,
    "}",
    "const chains = {}",
    "const metas = {}",
    // routeId → the page module's `searchSchema` export (or undefined). Populated lazily with
    // chains/metas so the mount can derive this route's typed `search` from the URL, matching the SSR.
    "const searchSchemas = {}",
    // routeId → the page's client-only search keys (`searchClientKeys`, or `[]`). The router reads this
    // by reference to decide when a same-route search change can skip the loader fetch (re-render only).
    "const searchClientKeys = {}",
    // routeId → the page's optional post-hydration client loader/action hooks. Hooks are populated only
    // after the route chunk loads, so routes that do not declare them remain ordinary route modules.
    "const routeHooks = {}",
    // routeId → the chain the server rendered for an `ssr = false` page: the same layouts (and
    // boundary), with the page's `HydrateFallback` - or an empty leaf - where the component goes.
    "const holds = {}",
    // routeId → the ids and `handle` exports `useMatches` reports (layouts, then the page).
    `const layoutIdsOf = ${jsValueLiteral(layoutIdsOf)}`,
    ...(live === undefined
      ? []
      : [
          `const __live = liveClient({ ${[
            "layoutIdsOf",
            ...(live.path === undefined ? [] : [`path: ${jsStringLiteral(live.path)}`]),
            ...(live.loadPath === undefined ? [] : [`loadPath: ${jsStringLiteral(live.loadPath)}`]),
          ].join(", ")} })`,
        ]),
    "const matchChains = {}",
    ...(keep === undefined
      ? []
      : [
          `const keepAliveTable = ${jsValueLiteral(keep)}`,
          `const __keep = keepAliveClient({ table: keepAliveTable, routeHooks, matchChains${live === undefined ? "" : ", fetchData: __live.fetchData"} })`,
        ]),
    `const ${options.copyChunks === true ? "loadRoute" : "loadModule"} = async (id) => {`,
    "  if (chains[id]) return",
    "  const mods = await loaders[id]()",
    // For an error route the `_error` module is appended LAST: wrap the page (now second-to-last) in
    // the adapter's boundary so a client render error renders the `_error` UI. DOM-transparent, so the
    // hydrated tree matches the SSR markup (which has no boundary). Falls back to the plain chain when
    // the adapter has no `errorBoundary`.
    // `metas[id]` is the chain's `meta` exports in head order (outermost layout → … → page), so a
    // soft-nav merges the layout chain's head with the page's - matching the SSR `<head>` (sitewide
    // layout tags persist across client navigation, no flash of page-only head). `_error` carries no
    // head (a terminal boundary), so it's excluded from the meta list for error routes.
    "  if (errorBoundary && errorRouteIds.has(id)) {",
    "    const fallback = mods[mods.length - 1].default",
    "    const page = mods[mods.length - 2].default",
    "    const layouts = mods.slice(0, mods.length - 2).map((m) => m.default)",
    "    chains[id] = [...layouts, errorBoundary(fallback), page]",
    "    metas[id] = mods.slice(0, mods.length - 1).map((m) => m.meta)",
    // The search-schema CHAIN is the layout modules + page (all but the appended `_error`), so a layout's
    // `searchSchema` merges with the page's. Client keys come from the page (second-to-last).
    "    searchSchemas[id] = mods.slice(0, mods.length - 1).map((m) => m.searchSchema)",
    "    searchClientKeys[id] = mods[mods.length - 2].searchClientKeys ?? []",
    "    matchChains[id] = { ids: [...(layoutIdsOf[id] ?? []), id], handles: mods.slice(0, mods.length - 1).map((m) => m.handle) }",
    "  } else {",
    "    chains[id] = mods.map((m) => m.default)",
    "    metas[id] = mods.map((m) => m.meta)",
    // The chain is every module (layouts + page); client keys come from the page (the last module).
    "    searchSchemas[id] = mods.map((m) => m.searchSchema)",
    "    searchClientKeys[id] = mods[mods.length - 1].searchClientKeys ?? []",
    "    matchChains[id] = { ids: [...(layoutIdsOf[id] ?? []), id], handles: mods.map((m) => m.handle) }",
    "  }",
    "  const page = errorRouteIds.has(id) ? mods[mods.length - 2] : mods[mods.length - 1]",
    // Only neutral name/mode metadata crosses into the router; a boundary's loader lives in the route's
    // backend half, which no browser bundle contains.
    "  const boundaryMods = errorRouteIds.has(id) ? mods.slice(0, -1) : mods",
    "  const boundaries = boundaryMods.flatMap((m) => (m.boundaries ?? []).map((b) => ({ name: b.name, mode: b.mode, ...(b.errorId === undefined ? {} : { errorId: b.errorId }) })))",
    `  routeHooks[id] = { clientLoader: page.clientLoader, clientAction: page.clientAction, shareData: page.shareData, ${keep === undefined ? "" : "keepAlive: page.keepAlive, "}boundaries }`,
    "  if (page.ssr === false) holds[id] = [...chains[id].slice(0, -1), page.HydrateFallback ?? (() => null)]",
    "}",
    ...(options.copyChunks === true
      ? [
          `const copyRealm = () => globalThis[Symbol.for(${jsStringLiteral(COPY_REALM)})]`,
          // A second prepare covers a copy definition the route's own code brought in.
          "const loadModule = async (id, path) => {",
          "  if (path === undefined) return loadRoute(id)",
          "  await Promise.all([loadRoute(id), copyRealm()?.prepare(path)])",
          "  await copyRealm()?.prepare(path)",
          "}",
        ]
      : []),
    // The server hands page state over as one inert JSON script; lift it onto the globals the
    // router, the deferred mapper and the adapters read, before any of them runs. Only the LAST
    // matching <script> counts, and only known keys: page HTML (sanitized user content) can carry an
    // element with the same id, and arbitrary keys copied onto `window` include `location`.
    `const handovers = document.querySelectorAll(${jsValueLiteral(`script[type="application/json"][id="${HANDOVER_ID}"]`)})`,
    "const handover = handovers[handovers.length - 1]",
    "if (handover !== undefined) {",
    '  const state = JSON.parse(handover.textContent || "{}")',
    `  for (const key of ${jsValueLiteral([
      ...HANDOVER_GLOBALS,
      ...(options.copyChunks === true ? [COPY_CHUNKS_GLOBAL] : []),
      ...(live === undefined ? [] : [LIVE_GLOBAL]),
    ])}) {`,
    "    if (Object.prototype.hasOwnProperty.call(state, key)) Reflect.set(window, key, state[key])",
    "  }",
    "}",
    "const patterns = [",
    ...patternRows,
    "]",
    // Derive the initial route from the URL (correct on refresh/deep-link); fall back to the
    // server-injected route id for non-pattern routes (e.g. _404, which matches nothing).
    "const matched = createMatcher(patterns)(location.pathname)",
    `const statusRoutes = ${jsValueLiteral(statusRoutes)}`,
    `const serverRoute = window.${ROUTE_GLOBAL} ?? ""`,
    // A terminal status page the server rendered (`_404`, `_410`, ...) outranks the URL match: a
    // loader that throws notFound() on `/learn/bad-slug` leaves a URL that still matches
    // `learn/[slug]`, and hydrating that route with null data over the 404 markup is wrong. Membership
    // in the status table, not a `_` prefix: `routes/_admin/index.tsx` is an ordinary routable id.
    "const terminal = Object.values(statusRoutes).includes(serverRoute)",
    // Map any `{__nifra_deferred: id}` placeholder in the SSR data to the registry's promise, so the
    // component receives real promises to `<Await>` (a no-op when a page has no deferred data).
    MAP_DEFERRED_SOURCE,
    "const initial = {",
    "  routeId: matched && !terminal ? matched.routeId : serverRoute,",
    "  params: matched && !terminal ? matched.params : {},",
    // pathname + search (NOT just pathname): the SSR render threads `pathname+search` into
    // `useLocation`/`useSearchParams`, so the hydrating initial state must carry the query too or a
    // page reading the search string would hydrate-mismatch. The #hash is client-only (never SSR'd).
    "  path: location.pathname + location.search,",
    `  data: mapDeferred(window.${DATA_GLOBAL}),`,
    // Undefined on a page-only app, which is exactly what the router treats as "no layout data".
    `  layoutData: window.${LAYOUT_DATA_GLOBAL} && window.${LAYOUT_DATA_GLOBAL}.map(mapDeferred),`,
    `  boundaries: mapDeferred(window.${BOUNDARY_GLOBAL}),`,
    `  serverComponents: window.${COMPONENT_GLOBAL},`,
    // The seed the server rendered the page with: the live client exchanges it for its first grant.
    ...(live === undefined ? [] : [`  live: window.${LIVE_GLOBAL},`]),
    // actionData (only set after a form POST) is in the initial state so the binding hydrates
    // consistently with the server-rendered markup; mapped through `mapDeferred` too so a deferred
    // action's placeholders become registry markers (a no-op when the action didn't defer).
    `  actionData: mapDeferred(window.${ACTION_GLOBAL}),`,
    "  pending: false,",
    "}",
    ...loadingLines,
    // With `_loading` pages the store is wrapped: a slow navigation then names a loading chain (the
    // shared layouts + the `_loading` component) for the mounted view to render in the meantime.
    keepAround(
      keep,
      loadings.length > 0
        ? `withLoading(createClientRouter({ patterns, initial, loadModule, statusRoutes${routerStatusOption}, searchClientKeys, routeHooks${liveFetch} }), { routes: loadingRoutes, modules: loadingModules, chains, searchSchemas, matchChains })`
        : `createClientRouter({ patterns, initial, loadModule, statusRoutes${routerStatusOption}, searchClientKeys, routeHooks${liveFetch} })`,
    ),
    // Kept pages hold the code they were rendered with: a hot update drops them.
    ...(keep === undefined
      ? []
      : [
          'if (import.meta.hot) for (const event of ["bun:afterUpdate", "vite:afterUpdate"]) import.meta.hot.on(event, () => router.dropKept("hot-update"))',
        ]),
    ...(options.serverComponents ? ["bindComponentRouter(router)"] : []),
    "installHistory(router)",
    "installForms(router)",
    // The container is found in the DOM, not baked in. `rootId` is a per-render option and this entry
    // is a per-build artifact, so a hardcoded id is a guess: `renderPage({ rootId: "app" })` produced a
    // perfect document that hydrated NOTHING, with no diagnostic, because the missing `#root` was
    // swallowed by an `if (root)`. `renderPage` marks a custom container with `ROOT_ATTRIBUTE`; the
    // default `#root` it leaves unmarked, which is what the fallback is for.
    `const root = document.querySelector("body > div[${ROOT_ATTRIBUTE}]") ?? document.getElementById("root")`,
    // Loud, because there is no recoverable case: this entry ships only in a document `renderPage`
    // opened a container in, so reaching here means the document is not the one it was built for.
    `if (!root) throw new Error(${jsValueLiteral(
      "[nifra/web] no hydration container found. The generated bootstrap mounts into the element " +
        `renderPage opened the app in - the one marked \`${ROOT_ATTRIBUTE}\` when a custom \`rootId\` ` +
        "is set, `#root` otherwise - and this document has neither. If you emit the document yourself, " +
        'keep `<div id="root">` around the SSR markup.',
    )})`,
    // Wait for framework-owned deferred CSS before loading/mounting the initial route. The coordinator
    // is a no-op for the default blocking links and always has a bounded fail-open terminal state.
    "waitForStyles().then(() => loadModule(initial.routeId)).then(() => {",
    // An `ssr = false` page: the server rendered its held chain, so the view hydrates THAT - under a
    // chain id no route file can produce - and is handed the real route a task later, once every
    // adapter has hydrated and subscribed. Only the first view is held; a client navigation to such a
    // page has no server markup to match and renders the component directly.
    "  let view = router",
    "  const hold = holds[initial.routeId]",
    "  if (hold) {",
    '    const id = "\\0ssr"',
    "    chains[id] = hold",
    "    searchSchemas[id] = searchSchemas[initial.routeId]",
    "    matchChains[id] = matchChains[initial.routeId]",
    "    const listeners = new Set()",
    "    let held = true",
    "    let base",
    "    let derived",
    "    view = {",
    "      ...router,",
    "      snapshot() {",
    "        const s = router.snapshot()",
    "        if (!held) return s",
    // One derived state per router state: the view's store must hand back a stable reference.
    "        if (base !== s) derived = { ...(base = s), routeId: id }",
    "        return derived",
    "      },",
    "      subscribe(listener) {",
    "        listeners.add(listener)",
    "        const off = router.subscribe(listener)",
    "        return () => (listeners.delete(listener), off())",
    "      },",
    "    }",
    "    setTimeout(() => {",
    "      held = false",
    "      for (const listener of [...listeners]) listener()",
    "    }, 0)",
    "  }",
    `  mountRouter({ router: view, routes: chains, searchSchemas, matchChains, container: root${keep === undefined ? "" : ", keepAlive: keepAliveTable"} })`,
    // Run the optional client loader only after the adapter has mounted the SSR tree. The initial
    // server data is already in `window.__NIFRA_DATA__`, so `serverLoader()` reuses it and cannot
    // duplicate the first request.
    "  router.hydrate().catch((error) => console.error('[nifra/web] clientLoader failed:', error))",
    // Once mounted: the first live load and the socket must not race the hydration.
    ...(live === undefined ? [] : ["  __live.attach(router)"]),
    // Next frame: the adapter has committed its initial hydration, so handlers are attached. Flip the
    // document to interactive (`data-nifra-hydrated` + `nifra:hydrated`) for apps to gate pre-hydration UI.
    "  requestAnimationFrame(signalHydrated)",
    "  router.subscribe(() => {",
    "    const s = router.snapshot()",
    // Merge the matched route's chain meta (layouts→page) into one head - same contract as SSR.
    "    if (!s.pending) {",
    // `origin: location.origin` matches the SSR `originOf(req)` (both are `URL.origin` for the same
    // page URL), so a soft-nav re-resolves the SAME absolute canonical/og:url - no head drift.
    "      const nonce = currentDocumentNonce()",
    "      const args = { data: s.data, pageData: s.data, params: s.params, origin: location.origin, ...(nonce === undefined ? {} : { nonce }) }",
    "      applyHead(mergeHeads(resolveChainMeta(metas[s.routeId] ?? [undefined], s.layoutData, args)), s.path)",
    "    }",
    "  })",
    "}).catch((error) => console.error('[nifra/web] hydration failed:', error))",
  ].join("\n")}\n`
}

export interface GenerateServerManifestOptions {
  /** Turn a route/layout source file (relative to the routes dir) into an import specifier -
   * same contract as `generateClientEntry`'s `resolve`. */
  readonly resolve: (file: string) => string
  /** The content-hashed client entry URL (from `buildClient`'s manifest), **baked** into the emitted
   * module - a disk-less worker can't read `manifest.json` at runtime. */
  readonly clientEntry: string
  /** The app's aggregate stylesheet URLs (`buildClient`'s `BuildManifest.css`) - baked as
   * `export const styles` so the server entry can hand them to `createWebApp` (→ `<link rel="stylesheet">`
   * in `<head>`). Without this the built SSR page ships no CSS link and renders unstyled. */
  readonly styles?: readonly string[] | undefined
  /** Per-route stylesheet URLs (`buildClient`'s `BuildManifest.routeStyles`) - baked as
   * `export const routeStyles` so a page links only the CSS its route chain uses. */
  readonly routeStyles?: Readonly<Record<string, readonly string[]>> | undefined
  /** How framework-owned stylesheet links should activate before the generated client mounts. */
  readonly cssLoading?: CssLoadingMode
  /** Locale key -> copy chunk URL (`buildClient`'s `BuildManifest.copyChunks`) - baked as
   * `export const copyChunks` when the client build split copy tables, for `createWebApp`. */
  readonly copyChunks?: Readonly<Record<string, string>> | undefined
  /**
   * The request path of every file the build emitted: the client build's `assets` and the `public/`
   * files it copied. Baked as `export const buildAssets` (a `Set`) and `isBuildAsset(pathname)`, so a
   * server entry or a host policy can allow exactly the files that exist. Omitted ⇒ neither export.
   */
  readonly buildAssets?: readonly string[] | undefined
  /** Emit **lazy** per-route loaders (`() => import("./routes/x")`, a static specifier) instead of
   * eager `import * as`, so a bundler with code-splitting emits one chunk per route - loaded on the
   * first request to it, not all at boot (smaller cold-start parse). Default `false` (eager). Both
   * modes are fs-free with statically-analyzable specifiers; only the *when* differs. */
  readonly lazy?: boolean
}

/**
 * Codegen: emit a **server manifest** module (as source) for disk-less edge runtimes (Cloudflare
 * Workers, …) - and, with a `target`, any portable server bundle. `discoverRoutes` scans `node:fs`
 * and dynamic-imports each route by a *runtime* path - neither exists on workerd. This instead emits
 * **statically-analyzable** imports of every route/layout/`_error`/terminal status page and each one's
 * backend half (so the bundler includes them) and
 * rebuilds the manifest with `buildManifest` - the SAME pure logic `discoverRoutes` feeds, so patterns
 * + layout chains are identical. Eager (`import * as`) by default; `lazy` emits `() => import(...)` so
 * a code-splitting bundler chunks per route. The emitted module exports `manifest` (consumed by
 * `createWebApp`, unchanged) + `clientEntry` (baked). Write it to a file and bundle it into the worker
 * entry (see `buildServer` in `@nifrajs/web/build`).
 */
// Route source files are emitted as EXTENSIONLESS import specifiers. An explicit `.tsx`/`.ts` in an
// import is a hard error under a plain `tsc` (TS5097) unless `allowImportingTsExtensions` is set - which
// only the nifra template tsconfig does - so the generated manifest failed a bare `tsc` with one error
// per route. Every bundler and `moduleResolution` still resolves the extensionless form to the source
// file, so dropping the extension costs nothing at build time and makes the output portable. Only a
// known TS/JS source extension is stripped; the map KEY keeps its extension (it is the route identifier
// `buildManifest` matches, not an import path).
const SOURCE_EXTENSION = /\.(?:[mc]?tsx?|[mc]?jsx?)$/
function moduleSpecifier(resolved: string): string {
  return resolved.replace(SOURCE_EXTENSION, "")
}

// A route's namespace is not assignable to `RouteModule` under a strict `tsc` (a backend half has no
// `default`, a typed `meta` narrows its data), so the table holds plain objects and the cast happens at
// `buildManifest`'s boundary - the same cast `discoverRoutes` applies to its dynamic import.
// The routes the scan found exporting `keepAlive`, which a disk-less server cannot scan again.
const keepAliveArg = (manifest: Manifest): string => {
  const files = [
    ...new Set(manifest.routes.filter((route) => route.keepAlive).map((route) => route.file)),
  ]
  return files.length === 0 ? "" : `, { keepAlive: ${jsValueLiteral(files)} }`
}
const LAZY_IMPORTER = "(file) => loaders[file] as () => Promise<RouteModule>"
const EAGER_IMPORTER = "(file) => () => Promise.resolve(modules[file] as RouteModule)"

export function generateServerManifest(
  manifest: Manifest,
  options: GenerateServerManifestOptions,
): string {
  const {
    resolve,
    clientEntry,
    styles,
    routeStyles,
    cssLoading: requestedCssLoading,
    copyChunks,
    buildAssets,
    lazy = false,
  } = options
  // A missing entry would bake `clientEntry = undefined` and the build would still succeed, leaving
  // every hydrating page to fail at request time. `""` stays valid: an app with no client script.
  if (typeof clientEntry !== "string") throw missingClientEntry(clientEntry)
  const cssLoading = normalizeCssLoading(requestedCssLoading ?? DEFAULT_CSS_LOADING)
  // Every unique source file in the manifest, both halves of each, sorted for stable output. This is the
  // one generated module that imports frontend and backend halves together: it is the server's
  // composition, and `buildManifest` pairs the halves again from these keys.
  const sources = [
    ...manifest.routes,
    ...Object.values(manifest.layouts),
    ...Object.values(manifest.errors ?? {}),
    ...(manifest.notFound ? [manifest.notFound] : []),
    ...Object.values(manifest.notFounds ?? {}),
    ...Object.values(manifest.statusPages ?? {}),
    ...Object.values(manifest.middlewares ?? {}),
  ]
  const files = [
    ...new Set(
      sources.flatMap((entry) =>
        entry.backend === undefined ? [entry.file] : [entry.file, entry.backend],
      ),
    ),
  ].sort()
  const header = [
    "// GENERATED by @nifrajs/web generateServerManifest - route manifest for the disk-less edge",
    "// (no filesystem; route imports are static specifiers the bundler resolves). buildManifest is",
    "// the same pure logic discoverRoutes feeds, so patterns + layout chains match exactly.",
    'import { buildManifest, type RouteModule } from "@nifrajs/web"',
  ]
  const clientEntryLine = `export const clientEntry = ${jsStringLiteral(clientEntry)}`
  // Baked stylesheet URLs so the server entry can pass them to createWebApp → <link rel="stylesheet">.
  // Always emitted (default empty) so consumers can `import { styles, routeStyles }` unconditionally.
  const stylesLine = `export const styles = ${jsValueLiteral(styles ?? [])}`
  const routeStylesLine = `export const routeStyles = ${jsValueLiteral(routeStyles ?? {})}`
  const cssLoadingLine = `export const cssLoading = ${jsStringLiteral(cssLoading)}`
  // Only a build that split copy tables has the line; its server entry is the one that imports it.
  const copyChunksLines =
    copyChunks === undefined || Object.keys(copyChunks).length === 0
      ? []
      : [`export const copyChunks = ${jsValueLiteral(copyChunks)}`]
  const buildAssetsLines =
    buildAssets === undefined
      ? []
      : [
          `export const buildAssets: ReadonlySet<string> = new Set(${jsValueLiteral([...new Set(buildAssets)].sort())})`,
          "export const isBuildAsset = (pathname: string): boolean => buildAssets.has(pathname)",
        ]
  if (lazy) {
    // Lazy: `() => import("./routes/x")` per route (static specifier → one chunk per route under a
    // code-splitting bundler, loaded on first request). The map keys are the route-relative paths
    // `buildManifest` expects; the importer it builds calls the per-file loader.
    const loaders = files.map(
      (file) =>
        `  ${jsStringLiteral(file)}: () => import(${jsStringLiteral(moduleSpecifier(resolve(file)))}),`,
    )
    return `${[
      ...header,
      "const loaders: Record<string, () => Promise<object>> = {",
      ...loaders,
      "}",
      clientEntryLine,
      stylesLine,
      routeStylesLine,
      cssLoadingLine,
      ...copyChunksLines,
      ...buildAssetsLines,
      `export const manifest = buildManifest(Object.keys(loaders), ${LAZY_IMPORTER}${keepAliveArg(manifest)})`,
    ].join("\n")}\n`
  }
  // Eager: `import * as` per route (all bundled into the entry, parsed at boot). Index-based
  // identifiers are collision-proof regardless of filename.
  const imports = files.map(
    (file, i) => `import * as m${i} from ${jsStringLiteral(moduleSpecifier(resolve(file)))}`,
  )
  const entries = files.map((file, i) => `  ${jsStringLiteral(file)}: m${i},`)
  return `${[
    ...header,
    ...imports,
    "const modules: Record<string, object> = {",
    ...entries,
    "}",
    clientEntryLine,
    stylesLine,
    routeStylesLine,
    cssLoadingLine,
    ...copyChunksLines,
    ...buildAssetsLines,
    `export const manifest = buildManifest(Object.keys(modules), ${EAGER_IMPORTER}${keepAliveArg(manifest)})`,
  ].join("\n")}\n`
}
