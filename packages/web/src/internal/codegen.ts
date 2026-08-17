import { MAP_DEFERRED_SOURCE } from "../deferred.ts"
import type { LayoutEntry, Manifest } from "../manifest.ts"
import {
  ACTION_GLOBAL,
  BOUNDARY_GLOBAL,
  DATA_GLOBAL,
  LAYOUT_DATA_GLOBAL,
  ROOT_ATTRIBUTE,
  ROUTE_GLOBAL,
} from "../render-seam.ts"
import { jsStringLiteral } from "./js-string.ts"
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
  const statusRoutes: Record<number, string> = {}
  // Routes whose loader appends a nearest `_error` module (LAST) - the client wraps the page in the
  // adapter's `errorBoundary(fallback)` for these, so a client render error shows the `_error` UI.
  const errorRouteIds: string[] = []
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
    loaderRows.push(`  ${JSON.stringify(route.id)}: ${lazyLoader(files)},`)
    patternRows.push(
      `  { routeId: ${JSON.stringify(route.id)}, pattern: ${JSON.stringify(route.pattern)} },`,
    )
  }
  if (manifest.notFound !== undefined) {
    loaderRows.push(`  "_404": ${lazyLoader([manifest.notFound.file])},`)
    statusRoutes[404] = "_404"
  }
  for (const [status, entry] of Object.entries(manifest.statusPages ?? {})) {
    const routeId = `_${status}`
    loaderRows.push(`  ${JSON.stringify(routeId)}: ${lazyLoader([entry.file])},`)
    statusRoutes[Number(status)] = routeId
  }

  return `${[
    // `/client`, never the root: the root's graph carries the server (renderPage, the static-file
    // server), and Vite's dev server evaluates what it is given instead of tree-shaking it.
    'import { createClientRouter, createMatcher, mergeHeads, resolveMeta } from "@nifrajs/web/client"',
    'import { applyHead, installForms, installHistory, signalHydrated } from "@nifrajs/web/client"',
    // Namespace import: `errorBoundary` is optional (an adapter may not export it). A namespace member
    // access yields `undefined` if absent - unlike a named import, which would be a link error.
    `import * as __adapter from ${JSON.stringify(clientModule)}`,
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
    `if (typeof mountRouter !== "function") throw new Error(${JSON.stringify(
      `[nifra/web] clientModule ${JSON.stringify(clientModule)} does not export \`mountRouter\`. ` +
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
    `const errorRouteIds = new Set(${JSON.stringify(errorRouteIds)})`,
    // Each route is a lazy loader: dynamic imports → Bun.build (splitting) emits one chunk per
    // route, shared layouts/deps deduped into shared chunks, so a route's code loads only when
    // visited. loadModule caches the [layouts…, page] component chain + the chain's meta list per id.
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
    "const loadModule = async (id) => {",
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
    "  } else {",
    "    chains[id] = mods.map((m) => m.default)",
    "    metas[id] = mods.map((m) => m.meta)",
    // The chain is every module (layouts + page); client keys come from the page (the last module).
    "    searchSchemas[id] = mods.map((m) => m.searchSchema)",
    "    searchClientKeys[id] = mods[mods.length - 1].searchClientKeys ?? []",
    "  }",
    "  const page = errorRouteIds.has(id) ? mods[mods.length - 2] : mods[mods.length - 1]",
    // Keep interception client-safe: only neutral name/mode metadata crosses into the router. The
    // server-side boundary load function (which may close over secrets) is never stored in the client
    // hook table or serialized into a browser bundle by this wiring.
    "  const boundaryMods = errorRouteIds.has(id) ? mods.slice(0, -1) : mods",
    "  const boundaries = boundaryMods.flatMap((m) => (m.boundaries ?? []).map((b) => ({ name: b.name, mode: b.mode, hasLoad: b.load !== undefined, ...(b.errorId === undefined ? {} : { errorId: b.errorId }) })))",
    "  routeHooks[id] = { clientLoader: page.clientLoader, clientAction: page.clientAction, boundaries }",
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
    // pathname + search (NOT just pathname): the SSR render threads `pathname+search` into
    // `useLocation`/`useSearchParams`, so the hydrating initial state must carry the query too or a
    // page reading the search string would hydrate-mismatch. The #hash is client-only (never SSR'd).
    "  path: location.pathname + location.search,",
    `  data: mapDeferred(window.${DATA_GLOBAL}),`,
    // Undefined on a page-only app, which is exactly what the router treats as "no layout data".
    `  layoutData: window.${LAYOUT_DATA_GLOBAL} && window.${LAYOUT_DATA_GLOBAL}.map(mapDeferred),`,
    `  boundaries: mapDeferred(window.${BOUNDARY_GLOBAL}),`,
    // actionData (only set after a form POST) is in the initial state so the binding hydrates
    // consistently with the server-rendered markup; mapped through `mapDeferred` too so a deferred
    // action's placeholders become registry markers (a no-op when the action didn't defer).
    `  actionData: mapDeferred(window.${ACTION_GLOBAL}),`,
    "  pending: false,",
    "}",
    `const statusRoutes = ${JSON.stringify(statusRoutes)}`,
    "const router = createClientRouter({ patterns, initial, loadModule, statusRoutes, searchClientKeys, routeHooks })",
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
    `if (!root) throw new Error(${JSON.stringify(
      "[nifra/web] no hydration container found. The generated bootstrap mounts into the element " +
        `renderPage opened the app in - the one marked \`${ROOT_ATTRIBUTE}\` when a custom \`rootId\` ` +
        "is set, `#root` otherwise - and this document has neither. If you emit the document yourself, " +
        'keep `<div id="root">` around the SSR markup.',
    )})`,
    // Load the initial route's chunk, then hydrate the Router (chain is cached). The initial head
    // is server-rendered; subsequent navigations update it from the matched route's meta + data.
    "loadModule(initial.routeId).then(() => {",
    "  mountRouter({ router, routes: chains, searchSchemas, container: root })",
    // Run the optional client loader only after the adapter has mounted the SSR tree. The initial
    // server data is already in `window.__NIFRA_DATA__`, so `serverLoader()` reuses it and cannot
    // duplicate the first request.
    "  router.hydrate().catch((error) => console.error('[nifra/web] clientLoader failed:', error))",
    // Next frame: the adapter has committed its initial hydration, so handlers are attached. Flip the
    // document to interactive (`data-nifra-hydrated` + `nifra:hydrated`) for apps to gate pre-hydration UI.
    "  requestAnimationFrame(signalHydrated)",
    "  router.subscribe(() => {",
    "    const s = router.snapshot()",
    // Merge the matched route's chain meta (layouts→page) into one head - same contract as SSR.
    "    if (!s.pending) {",
    // `origin: location.origin` matches the SSR `originOf(req)` (both are `URL.origin` for the same
    // page URL), so a soft-nav re-resolves the SAME absolute canonical/og:url - no head drift.
    "      const args = { data: s.data, params: s.params, origin: location.origin }",
    "      applyHead(mergeHeads((metas[s.routeId] ?? [undefined]).map((m) => resolveMeta(m, args))))",
    "    }",
    "  })",
    "})",
  ].join("\n")}\n`
}

export interface GenerateRouteSearchTypesOptions {
  /** Turn a route source file into a module specifier for a `typeof import(...)` type - the same contract
   * as `generateClientEntry`'s `resolve`, but WITHOUT a file extension (a `.d.ts` imports a module, not a
   * path). Relative to wherever the emitted `.d.ts` is written. */
  readonly resolve: (file: string) => string
  /** The module whose `RouteSearch` interface is augmented (default `"@nifrajs/web"`). Every adapter's
   * `NavigateTarget` reads `@nifrajs/web`'s `RouteSearch`, so the default types `navigate` on all of them. */
  readonly module?: string
}

/**
 * Codegen: emit a `.d.ts` that types cross-route `navigate({ to, search })` against each route's
 * `searchSchema`. It augments the {@link RouteSearch} map with `"<pattern>": SearchOf<typeof import(...)>`
 * for every **static** route (one with no `:param`/`*` segment - a concrete `to` a caller can pass; a
 * dynamic route's concrete path can't match its pattern key, so those keep the loose object form). Written
 * by `nifra sync-routes` next to the route tree and included in the app's `tsconfig`; because it is
 * regenerated from the route files, a `navigate` whose `search` no longer matches the route's schema
 * becomes a `tsc` error - the same drift guarantee as nifra's typed client, no hand-maintained map.
 */
export function generateRouteSearchTypes(
  manifest: Manifest,
  options: GenerateRouteSearchTypesOptions,
): string {
  const { resolve, module = "@nifrajs/web" } = options
  // Static routes only (no `:param` / `*` catch-all): their pattern IS a concrete `to`. Sorted for stable
  // output; a dynamic route falls through to the loose `{ to: string; search?: Record<...> }` form.
  const entries = manifest.routes
    .filter((route) => !/[:*]/.test(route.pattern))
    .map((route) => [route.pattern, resolve(route.file)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(
      ([pattern, spec]) =>
        `    ${JSON.stringify(pattern)}: SearchOf<typeof import(${JSON.stringify(spec)})>`,
    )
  return `${[
    "// GENERATED by @nifrajs/web generateRouteSearchTypes - typed cross-route navigate({ to, search }).",
    "// Regenerated from the route files; a stale navigate search shape becomes a tsc error. Do not edit.",
    'import type { SearchOf } from "@nifrajs/web"',
    `declare module ${JSON.stringify(module)} {`,
    "  interface RouteSearch {",
    ...entries,
    "  }",
    "}",
    "export {}",
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
 * **statically-analyzable** imports of every route/layout/`_error`/terminal status page (so the bundler includes them) and
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

export function generateServerManifest(
  manifest: Manifest,
  options: GenerateServerManifestOptions,
): string {
  const { resolve, clientEntry, styles, routeStyles, lazy = false } = options
  // Every unique source file in the manifest (routes + layouts + error/status pages), sorted for stable output.
  const files = [
    ...new Set([
      ...manifest.routes.map((r) => r.file),
      ...Object.values(manifest.layouts).map((l) => l.file),
      ...Object.values(manifest.errors ?? {}).map((e) => e.file),
      ...(manifest.notFound ? [manifest.notFound.file] : []),
      ...Object.values(manifest.statusPages ?? {}).map((page) => page.file),
    ]),
  ].sort()
  const header = [
    "// GENERATED by @nifrajs/web generateServerManifest - route manifest for the disk-less edge",
    "// (no filesystem; route imports are static specifiers the bundler resolves). buildManifest is",
    "// the same pure logic discoverRoutes feeds, so patterns + layout chains match exactly.",
    'import { buildManifest, type RouteModule } from "@nifrajs/web"',
  ]
  const clientEntryLine = `export const clientEntry = ${JSON.stringify(clientEntry)}`
  // Baked stylesheet URLs so the server entry can pass them to createWebApp → <link rel="stylesheet">.
  // Always emitted (default empty) so consumers can `import { styles, routeStyles }` unconditionally.
  const stylesLine = `export const styles = ${JSON.stringify(styles ?? [])}`
  const routeStylesLine = `export const routeStyles = ${JSON.stringify(routeStyles ?? {})}`
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
      "const loaders: Record<string, () => Promise<RouteModule>> = {",
      ...loaders,
      "}",
      clientEntryLine,
      stylesLine,
      routeStylesLine,
      "export const manifest = buildManifest(Object.keys(loaders), (file) => () => loaders[file]())",
    ].join("\n")}\n`
  }
  // Eager: `import * as` per route (all bundled into the entry, parsed at boot). Index-based
  // identifiers are collision-proof regardless of filename.
  const imports = files.map(
    (file, i) => `import * as m${i} from ${JSON.stringify(moduleSpecifier(resolve(file)))}`,
  )
  const entries = files.map((file, i) => `  ${JSON.stringify(file)}: m${i},`)
  return `${[
    ...header,
    ...imports,
    "const modules: Record<string, RouteModule> = {",
    ...entries,
    "}",
    clientEntryLine,
    stylesLine,
    routeStylesLine,
    "export const manifest = buildManifest(Object.keys(modules), (file) => () => Promise.resolve(modules[file]))",
  ].join("\n")}\n`
}
