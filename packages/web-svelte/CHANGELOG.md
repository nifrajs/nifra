# @nifrajs/web-svelte

## 5.9.0

### Patch Changes

- 2ffa7c1: The React, Preact, Solid, Svelte and Vue `useServerFn` bindings take their function through one shared helper in `@nifrajs/web/internal/client-server-fn`.
  
  The React, Svelte and Vue client and keep-alive mounts read a hydration verification runner's hooks through one reader in `@nifrajs/web/internal/hydration-assurance`. Recoverable errors and warnings reach the runner as before.
- 71dea89: Every binding's `useNavigate` returns one navigate from `@nifrajs/web/internal/navigate-runtime`, the same function on every call. The React, Preact, Solid and Vue `Hole` components read their boundary state through the `HoleState` type in `@nifrajs/web/internal/hole-runtime`.
- 7ee17d0: `nifra check --sarif` and the command catalog's check output map report entries to diagnostics through one step. The CLI's page rules read the routes manifest and a `createWebApp` call's options through shared helpers, the layout migration applies its text edits through one function, two source scans share one route-registration reader, the two sync commands share their output schema and flag, and the Python and Go SDK generators share their setup and map-type reading.
  
  `create-nifra` passes the flags it parsed to `scaffold` as they are.
  
  `@nifrajs/web`'s PostCSS and Sass plugins build their JS module through one function, its client-build guards share one import-chain search, a page route's failed loaders answer through one step, and the router and the live client build a route data request's headers through one function.
  
  `@nifrajs/web-svelte`'s Svelte and MDX plugins emit scoped CSS through the stylesheet emitter in `@nifrajs/web/plugins/kit`, as the other kit plugins do. The virtual stylesheet import they write is now `?nifra-svelte-css` (`?nifra-svelte-mdx-css` for MDX), and its resolved path stays slash-separated on Windows.
  
  `@nifrajs/mcp` builds its capabilities once for `initialize` and `server/discover`. `@nifrajs/agent-review`'s composer uses the parser's outcome rule and evidence order, and the parser reads its two string lists through one reader. `@nifrajs/pi` reads message text through one helper, and core's evidence report sorts its findings through one comparator.
- a0fe5bf: The keep-alive mounts of the React, Preact, Svelte, Solid and Vue adapters take their framework-free half from `@nifrajs/web/internal/keep-alive-mount`. This covers the slot tree of each router state, the parking each committed tree goes to, render props made once per state, and the slots under each layout. Each adapter still renders the slots its own way. Kept pages behave as before.
- 159ae97: The React, Preact and Vue client mounts and the Svelte keep-alive mount build a route's props with one builder from `@nifrajs/web`. The props a page receives are unchanged.
- Updated dependencies [2ffa7c1]
- Updated dependencies [100a0aa]
- Updated dependencies [71dea89]
- Updated dependencies [9c20e05]
- Updated dependencies [9942748]
- Updated dependencies [8cdb138]
- Updated dependencies [be1c677]
- Updated dependencies [f399e06]
- Updated dependencies [93e7078]
- Updated dependencies [2c2f58b]
- Updated dependencies [123409c]
- Updated dependencies [7ee17d0]
- Updated dependencies [68d9f31]
- Updated dependencies [fa7d102]
- Updated dependencies [ddeb735]
- Updated dependencies [a3fb195]
- Updated dependencies [47a864f]
- Updated dependencies [9942748]
- Updated dependencies [ffcf41a]
- Updated dependencies [7a15327]
- Updated dependencies [866c8ec]
- Updated dependencies [bc42fd2]
- Updated dependencies [a29d1cc]
- Updated dependencies [9942748]
- Updated dependencies [77b98ea]
- Updated dependencies [a3caf9b]
- Updated dependencies [a0fe5bf]
- Updated dependencies [7ba5c9b]
- Updated dependencies [0445564]
- Updated dependencies [180bf9d]
- Updated dependencies [ff9bc11]
- Updated dependencies [8094874]
- Updated dependencies [a7b89ee]
- Updated dependencies [34b780e]
- Updated dependencies [111c3be]
- Updated dependencies [5bd225e]
- Updated dependencies [d6e6617]
- Updated dependencies [5bc60b7]
- Updated dependencies [159ae97]
- Updated dependencies [6ba9740]
- Updated dependencies [5f4416a]
- Updated dependencies [bc05ec5]
- Updated dependencies [d3c050e]
- Updated dependencies [c4ed3e9]
- Updated dependencies [9942748]
- Updated dependencies [5bc60b7]
- Updated dependencies [3299474]
- Updated dependencies [543d00a]
- Updated dependencies [020eb7b]
- Updated dependencies [9942748]
- Updated dependencies [9785cd4]
  - @nifrajs/web@5.9.0
  - @nifrajs/core@5.9.0

## 5.8.0

### Patch Changes

- Updated dependencies [8720338]
  - @nifrajs/core@5.8.0
  - @nifrajs/web@5.8.0

## 5.7.0

### Minor Changes

- 86a62c0: `@nifrajs/image` and `@nifrajs/i18n` are optional peers of every UI adapter rather than
  dependencies, so an app installs them only when it imports the adapter's `/image` or `/i18n` entry.
  An app that imports either entry adds the matching package beside the adapter; one that already
  imports it directly, as the image and i18n guides show, needs nothing more.

### Patch Changes

- Updated dependencies [0a29798]
- Updated dependencies [b141cf4]
- Updated dependencies [a97b081]
- Updated dependencies [0a29798]
- Updated dependencies [0a29798]
- Updated dependencies [25f97c2]
- Updated dependencies [22df027]
- Updated dependencies [b3d8ac9]
- Updated dependencies [b141cf4]
- Updated dependencies [25f97c2]
- Updated dependencies [67d82f1]
- Updated dependencies [e7479fe]
- Updated dependencies [d083ad2]
- Updated dependencies [25f97c2]
- Updated dependencies [b141cf4]
- Updated dependencies [b795cd9]
- Updated dependencies [a57b75c]
- Updated dependencies [911204f]
- Updated dependencies [911204f]
- Updated dependencies [0e59830]
- Updated dependencies [911204f]
  - @nifrajs/web@5.7.0
  - @nifrajs/core@5.7.0

## 5.6.0

### Minor Changes

- 5ce69b2: Experimental and unstable: partial prerendering, from the new `@nifrajs/web/ppr` subpath. With `createWebApp({ experimental: { ppr: partialPrerendering({ shellChecks }) } })`, a route whose backend half exports `shellLoader` streams a shell shared by every visitor, then each `dynamic` boundary as it settles. An app that does not import the subpath ships none of its server code.
  
  - **Shells.** The shell loader (typed with `defineShellLoader`) receives params, locale, declared `variations`, the configured `origin` and the in-process `api`, never the request. A shell is shared only for a route that passed `compileShells` for this deployment, which bundles the page's and its layouts' whole modules, `meta`, `handle` and `searchSchema` included, with `shellLoader`, and refuses one reaching a request-scoped module, including `getContext()` or `tryGetContext()` from `@nifrajs/middleware/context-storage`; it takes the server build's `plugins`, such as `svelteBunPlugin("ssr")`. Any other route renders whole. `checkShellCanaries(app, paths)` requests each path with unique cookie, `Authorization`, header and query values and reports each one that reaches the shared shell, which catches visitor data an app keeps in module state.
  - **Caching.** A shell older than the route's `revalidate` is served while one rebuild runs behind it; a failing rebuild keeps the old shell for up to ten times `revalidate` (at most a day); a shell loader's `notFound()` is remembered for 60 seconds, during which the route starts no hole; a route already building four shells renders further misses whole. A shell loader still running at `maxHoleTimeoutMs` fails the requests waiting on it and keeps nothing, and its build counts against the route's four until the loader ends. While the store has room every key builds its shell on its first request; once it is full, a key's shell is built on its second request (`shellAfterRequests`, default 2) and the first streams the page whole, each hole as it settles, so a path requested once cannot evict a popular shell; `checkShellCanaries` requests a path until a shell answers. `shellVariations`, closed sets of query values, each select their own shell. `pprShells(app)` drops shells and shared hole frames by tag, as a `createInvalidator` data cache, keeping no build of either that was running when the purge landed, and reports admission and unsent-byte counters. A `revalidateTags` function on the route or a shared hole gets the shell's URL: the configured origin, the path and the declared variations, never the visitor's Host or other query. A page cache such as `withISR` never stores a partially prerendered route's response, whichever way it rendered, since its holes are one visitor's.
  - **Holes.** A route has 1 to 32 holes, each with a `boundaryLoaders` entry, named with 1-32 lowercase letters, digits and single hyphens, starting with a letter and not ending with a hyphen; a hole's `timeout` is 1 to 30000 ms. A hole that returns or throws a redirect or a status renders its error state, since the shell's status and headers are already sent. Hole HTML is checked on the server and inserted without running scripts, every script in the document is allowed by hash, and a navigation that loads another page cancels the holes still loading, while a search change the browser handles alone leaves them filling. Every hole loader runs under its own deadline and a per-process admission limit that stops admitting a boundary whose loaders keep running after their abort; a prefetch starts no hole. A client that stops reading gets its later holes as errors once its unsent bytes pass a per-response budget, and the slowest readers are cut off when the process's pass its own. Every limit is a default in `PPR_DEFAULTS`, overridable per app.
  - **Routes.** `partialPrerendering({ origin })` gives `shellLoader` and the shell's `meta` the deployment's public origin, never a visitor's Host. A layout above a partially prerendered page may have a loader only as a `gate`, which runs to redirect or refuse and whose data reaches no response. In development, a shell with fewer than 200 characters of text warns, since Safari does not paint such a page until its last hole arrives, and so does a hole whose fallback renders empty.
  - **Shared holes.** A boundary with `mode: "shared"` is the same for every visitor: its loader gets the shell's context, never the request, and its frame is built once per route, params, locale and variations, kept on its own `revalidate` and `revalidateTags`, and sent right after the shell. A visitor who arrives while it builds waits up to the hole's timeout, then gets the error slot. A failed build is never kept. `compileShells` checks a shared loader with the shell and refuses one that reaches a request-scoped module; a shared hole it did not check loads for every visitor. `Route.BoundaryLoaders` types a shared loader with the shell's context and requires `revalidate`.
  - **Many processes.** `partialPrerendering({ store, storeSecret })` puts a `CacheStore` such as `KVCacheStore` behind each process's own shells and shared hole frames, so a process that has not built one reads it from the store. Every entry is signed over its key, deployment and contents, and one that fails the check is a miss. A route whose `revalidateTags` the store cannot drop keeps its entries in the process. A process reads a shell or shared frame it holds from the store again once `sharedRecheckMs` (default 1000) passes, so a purge on one process reaches the others, and a store read slower than `holeTimeoutMs` is a miss. Shells are kept apart by client build, by each route's checked shell code and by an optional `deployment` name, so a server-only change never serves an older shell.
  - **Runtimes.** Partially prerendered pages stream on Bun, Node, Deno and Cloudflare Workers. A shell builds outside any visitor's async context, including an app created inside its first request. On Workers the shell store defaults to 8 MB, the cancel beacon is off, a stale shell's rebuild runs under `waitUntil`, and the shell check refuses shell code that imports `cloudflare:workers`, which reads the Worker's env with no request.
  - **Reloading.** When a page reloads after an action or a live refresh, its holes reload in place: each hole gets its new server HTML, an interactive hole's root keeps its state and gets new props, a hole that fails shows the error slot, and no fallback shows on the way. A hole loader names the live keys it reads with `ctx.live(...keys)`, a shared hole's with the keys kept in its entry; a write to one of them reloads that hole, and a live load leaves each hole whose keys did not change as it is.
  - **Server components in holes.** A `dynamic` hole can show a server component: `serverHole(Component)`, from the new `@nifrajs/web/server-components/hole` subpath, is its `render`; its loader returns the component's input, and the component authorizes, loads and renders for each visitor under the hole's timeout and admission. `createServerComponents({ holes })` lists the components each route's holes may show; a route that shows one the list leaves out fails, and a route either owns server components or shows them in holes. Such a hole is not interactive, and its component cannot set a cookie or a header. In the browser, `holeComponents(client)` from `@nifrajs/web/server-components/client` mounts the islands inside it: after a client navigation the hole mounts from its fill, a blocking render carries its HTML and its islands hydrate over it, and a reload replaces its HTML and mounts its islands afresh. It is built with the coordinated compiler, and the browser gets the component's HTML and islands, never its view.
  - **Adapters.** `Hole` from `@nifrajs/web-react/ppr`, and `Hole` from `@nifrajs/web-svelte/hole` with `ui(Component, props)` from `@nifrajs/web-svelte/ppr`, place a hole, hydrate an interactive one as its own root and reload it in place. Both adapters render a hole's HTML with `renderFragment`; a React hole may show an image, responsive or not, since the preload hints React writes ahead of it are left out.
- f1d794e: `keepAlive` routes work with the Preact, Solid and Vue adapters as well as React and Svelte. Each of the three ships `usePageVisibility()`, `onPageHide` and `onPageShow` from its `/router` subpath; Vue keeps pages with its own `<KeepAlive>` and renders no wrapper elements. `@nifrajs/web-svelte/router` gains `usePageVisibility()`, and a `useBlocker` in a hidden Svelte page blocks nothing.
  
  A page left with a route open in a modal is kept with it, and back to that entry opens the modal again. Islands in a kept page can pause with `onPageHide(el, fn)` and `onPageShow(el, fn)` from `@nifrajs/web/islands`. Server components in a kept page stay mounted while it is hidden: `bindComponentRouter` parks them on the page events, and outlets pass their host to `controller.unmount(instance, host)` so a parked page and the page on screen can hold the same instance. A parked component waits for its page, taken back when the page is shown and released when it is dropped; `controller.isParked(instance, host)` tells an outlet whose framework cleans up a hidden page's effects, as React's `<Activity>` does, to leave it parked. In Vue, a layout inside a kept branch reads the branch's visibility, and a page dropped inside a hidden branch unmounts. In Preact, as in React, props a layout adds with `cloneElement` reach a kept page.
  
  The `nifra:pagehide` event fires as the router hides a page, while the page is still in the document and before the router's subscribers see the state that hides it.
- c387fb9: A route can keep its page mounted across navigations: `export const keepAlive = true` (or `{ revalidate: false }`) in a React or Svelte route. Back and forward to a kept page show it at once with its state, scroll and focus as the visitor left them, then revalidate its data in the background unless `revalidate` is `false` (a route's `clientLoader` then runs again over the server data the page was built from). At most three pages are kept per tab, each for up to ten minutes hidden (`keepAlive: { maxAge }` changes that). Kept pages are dropped when the visitor signs in or out (an identity epoch cookie the server sets, shared across tabs, which expires with the session cookie and is renewed with a rolling one), and the page on screen as that happens is not kept; also on a hot update and when the document enters the browser's own back/forward cache. Pages are wrapped at the layouts they do not share with the routes they navigate to, so a shared layout keeps one instance. `usePageVisibility()` from `@nifrajs/web-react/router` and `onPageHide` / `onPageShow` from `@nifrajs/web-svelte/router` let a kept page pause its own work while hidden.
  
  `createWebApp({ keepAlive: { identityCookies, ignoreCookies } })` names the cookies that carry who the visitor is, beyond the defaults for nifra, Better Auth and Auth.js sessions; `rotateIdentityEpoch(c)` drops kept pages from a handler that changes identity another way. In development, a changed HttpOnly cookie that is neither an identity cookie nor ignored is reported once, and so is a stylesheet rule that selects a kept page as a direct child of its layout (the wrapper sits between them). `nifra doctor` names the kept routes of an app that uses an auth package.
  
  An app with no `keepAlive` route ships the same client code as before.
- 4f40009: `useQuery` (and Solid's `createQuery`) take the query cache's options as a third argument: `staleTime`, and `live` to refetch on the live keys a page's loaders grant. React's `useQuery` now hands its options to the client whole.

### Patch Changes

- af398dc: A kept page's two wrappers, `[data-nifra-entry]` and `[data-nifra-page]`, are `<slot>` elements, which browsers lay out as `display: contents`. They carry no inline style, so under a `style-src` without `'unsafe-inline'` they take no box from the first paint and the console reports nothing, and a wrapper inside a `<p>` stays inside it.
- dfb59d1: The Solid and Svelte MDX plugins load `@mdx-js/mdx` and `mdsvex` through the same optional-peer
  loader as the Sass, PostCSS, StyleX and SVG plugins. A missing peer still fails with an install hint.
  A peer that is installed but throws while loading now fails with that error as the cause, where it
  was reported as not installed.
- 328003a: While an intercept boundary shows a route over the page, the route props describe the page underneath: `path`, the typed `search`, and so `useLocation`, `useSearch` and `useMatches`, come from the page's own path. Before, they read the modal's URL, so the page lost its query string and `useMatches` sliced the modal's URL against the page's route chain.
- 18c3d73: A reload of a path on screen keeps the identity of the parts of its data that it did not change. This covers an action's revalidation, `invalidate()`, the paths an action names with `revalidate()`, a live refresh, a fetcher loading its path again, and a target an intercept boundary holds. Plain objects and arrays compare by content, Dates by time, and array elements with an `id` pair by it, so a prepend or a reorder keeps every unchanged row, and each earlier element is kept for at most one new one; an array whose first 32 elements keep nothing is taken whole, later unchanged elements included. A plain JSON response with the same text as the one the page was read from reuses the page's data without parsing it; a response with deferred parts is always parsed. An unchanged reload publishes only its `pending` flag.
  
  A page exports `shareData = false` to get fresh data on every reload. `FetchRouteData` takes an optional seventh argument, `read` (a `DataText`), after `purpose` and `hosts`, that a custom transport may ignore; the same-text skip then does not apply, while sharing still does.
  
  The adapters' client mounts take advantage of it. React and Preact render each layout and the page memoized on its own props, with a layout's children read through context, so an unchanged reload re-renders neither a layout nor a memoized row. Vue passes each layout the next level as a stable slot. Svelte and Solid derive `data` and the layouts' data with an identity check, so an effect on them runs again only when a reload changed them; Solid's `<For>` then keeps every unchanged row and its DOM state. Svelte pages receive `data` as the router published it rather than as a deep reactive proxy of it. React, Preact and Vue keep `search` as the same object while the query is the same.
- Updated dependencies [676a1f0]
- Updated dependencies [f1a424d]
- Updated dependencies [a0ae2e6]
- Updated dependencies [0743b66]
- Updated dependencies [671a952]
- Updated dependencies [0ec3f30]
- Updated dependencies [caa1ef8]
- Updated dependencies [7c5fc94]
- Updated dependencies [13f6b38]
- Updated dependencies [d76bc3f]
- Updated dependencies [d76bc3f]
- Updated dependencies [4bc7d8d]
- Updated dependencies [b73319d]
- Updated dependencies [aa567fa]
- Updated dependencies [6b90278]
- Updated dependencies [5ce69b2]
- Updated dependencies [d43bc92]
- Updated dependencies [7810dc5]
- Updated dependencies [6126cb1]
- Updated dependencies [ef2d101]
- Updated dependencies [dec48fc]
- Updated dependencies [c403814]
- Updated dependencies [db0bacd]
- Updated dependencies [6582724]
- Updated dependencies [f48b257]
- Updated dependencies [0222181]
- Updated dependencies [f1d794e]
- Updated dependencies [b7fb47f]
- Updated dependencies [c387fb9]
- Updated dependencies [8db6a2c]
- Updated dependencies [4b196d2]
- Updated dependencies [1b4b448]
- Updated dependencies [f39ee8c]
- Updated dependencies [4f40009]
- Updated dependencies [05608b9]
- Updated dependencies [baa926f]
- Updated dependencies [2eabd83]
- Updated dependencies [328003a]
- Updated dependencies [a6010f9]
- Updated dependencies [87f475d]
- Updated dependencies [3e1e275]
- Updated dependencies [c4cf782]
- Updated dependencies [9efc061]
- Updated dependencies [9889273]
- Updated dependencies [fb1cc25]
- Updated dependencies [23d0644]
- Updated dependencies [15c9d60]
- Updated dependencies [78e64e2]
- Updated dependencies [f25a8d2]
- Updated dependencies [778e430]
- Updated dependencies [18c3d73]
- Updated dependencies [7ec0f81]
- Updated dependencies [2538b70]
- Updated dependencies [48f78f0]
- Updated dependencies [baaac3d]
- Updated dependencies [2c213b2]
- Updated dependencies [db9f041]
- Updated dependencies [033ed0f]
- Updated dependencies [1704919]
- Updated dependencies [375711b]
- Updated dependencies [bb35ad0]
- Updated dependencies [c7d233d]
- Updated dependencies [feff82f]
- Updated dependencies [a540dad]
  - @nifrajs/core@5.6.0
  - @nifrajs/web@5.6.0
  - @nifrajs/i18n@5.6.0
  - @nifrajs/image@5.6.0

## 5.5.1

### Patch Changes

- Updated dependencies [a0b1ab4]
  - @nifrajs/core@5.5.1
  - @nifrajs/i18n@5.5.1
  - @nifrajs/web@5.5.1
  - @nifrajs/image@5.5.1

## 5.5.0

### Patch Changes

- Updated dependencies [9e6a0a5]
- Updated dependencies [c3ba1cb]
- Updated dependencies [df7ef2e]
- Updated dependencies [b8595b1]
- Updated dependencies [c37575c]
- Updated dependencies [6cc9e11]
- Updated dependencies [9e6a0a5]
- Updated dependencies [28dd544]
- Updated dependencies [662afb0]
- Updated dependencies [662afb0]
- Updated dependencies [9fd49ec]
- Updated dependencies [61113d8]
- Updated dependencies [506a387]
- Updated dependencies [9e6a0a5]
- Updated dependencies [389e1b6]
- Updated dependencies [662afb0]
- Updated dependencies [a11fe77]
- Updated dependencies [fa5b67c]
  - @nifrajs/web@5.5.0
  - @nifrajs/core@5.5.0
  - @nifrajs/i18n@5.5.0
  - @nifrajs/image@5.5.0

## 5.4.0

### Patch Changes

- Updated dependencies [e7d43ca]
- Updated dependencies [5183c00]
- Updated dependencies [01b97ec]
- Updated dependencies [e589893]
- Updated dependencies [ff66db6]
- Updated dependencies [02ac072]
- Updated dependencies [529f8d2]
  - @nifrajs/web@5.4.0
  - @nifrajs/core@5.4.0
  - @nifrajs/i18n@5.4.0
  - @nifrajs/image@5.4.0

## 5.3.0

### Patch Changes

- Updated dependencies [7ab9692]
- Updated dependencies [7ab9692]
- Updated dependencies [0e1d03f]
- Updated dependencies [808bac8]
- Updated dependencies [605c246]
- Updated dependencies [271917a]
- Updated dependencies [d4bae56]
- Updated dependencies [007060d]
- Updated dependencies [69dfb60]
- Updated dependencies [190ab39]
- Updated dependencies [605c246]
- Updated dependencies [13224fe]
- Updated dependencies [00c266e]
- Updated dependencies [7cf8df3]
  - @nifrajs/core@5.3.0
  - @nifrajs/i18n@5.3.0
  - @nifrajs/image@5.3.0
  - @nifrajs/web@5.3.0

## 5.2.1

### Patch Changes

- @nifrajs/core@5.2.1
  - @nifrajs/i18n@5.2.1
  - @nifrajs/image@5.2.1
  - @nifrajs/web@5.2.1

## 5.2.0

### Minor Changes

- 1d20d1f: An app registers its locale routing once: `export const i18n = urls` (the router `defineI18nRouting()` returns) from `backend/framework.ts`, which `nifra dev`, `nifra build` and the generated server entry pass to `createWebApp({ i18n })`. Every document then takes `<html lang dir>` from the registry's `documentMeta(localeOf(path))` unless the route's meta sets `lang`, on a hard load and after each client navigation, and carries `Content-Language`. Each adapter's new `useLocale()` returns the page's locale key, and `<I18nProvider>` formats in the page's locale when no `locale` is passed, with no loader handing either over. A route under a `[lang]` or `[[lang]]` directory runs `matchSegment()` before any middleware: an unserved locale, or a page missing from it, is a 404 through the app's `_404`, and a non-canonical prefix such as `/en/x` with an unprefixed default is a 308 to `/x`.

### Patch Changes

- 9498cf8: The package ships its `CHANGELOG.md`, so the installed package has the notes for every version, as the GitHub release does. Before, the tarball held only the code, `README.md`, `LICENSE` and `package.json`.
- Updated dependencies [9498cf8]
- Updated dependencies [1f3ff32]
- Updated dependencies [4bb8e52]
- Updated dependencies [cdff19d]
- Updated dependencies [5edd0ba]
- Updated dependencies [000b4cb]
- Updated dependencies [c5455fb]
- Updated dependencies [6082ba5]
- Updated dependencies [fd58beb]
- Updated dependencies [ea25a61]
- Updated dependencies [ed13e36]
- Updated dependencies [281a48e]
- Updated dependencies [281a48e]
- Updated dependencies [1d20d1f]
- Updated dependencies [1d20d1f]
- Updated dependencies [746ada9]
- Updated dependencies [1d20d1f]
- Updated dependencies [b9e7c6b]
  - @nifrajs/core@5.2.0
  - @nifrajs/i18n@5.2.0
  - @nifrajs/image@5.2.0
  - @nifrajs/web@5.2.0

## 5.1.0

### Patch Changes

- 6594e19: `<svelte:head>` and Vue's `<Teleport>` are server-rendered. Both were dropped from the HTML, so a `noindex` robots tag, a canonical link or a teleported dialog appeared only after hydration, and never with JavaScript off.
  
  - `@nifrajs/web-svelte` puts what `<svelte:head>` renders at the end of the document's `<head>`.
  - `@nifrajs/web-vue` puts each teleport's content as the first children of its target, where Vue's hydration reads it. `body` content goes first in `<body>`. An `#id` target the app renders empty receives the content, and one the app does not render gets a container before the app root. Any other selector, a target with children of its own, and a page that uses `defer()` keep rendering teleports on the client, now with a development warning.
  - `@nifrajs/web`: a render adapter that sets `documentParts` is passed `options.parts` and adds `head` and `body` markup there. An adapter without it is unchanged.
- Updated dependencies [78b2a04]
- Updated dependencies [638efe5]
- Updated dependencies [2a0a5d3]
- Updated dependencies [5372e3a]
- Updated dependencies [b276c67]
- Updated dependencies [29d6649]
- Updated dependencies [2a0a5d3]
- Updated dependencies [72e1b4b]
- Updated dependencies [7bb8a67]
- Updated dependencies [513ec28]
  - @nifrajs/web@5.1.0
  - @nifrajs/core@5.1.0
  - @nifrajs/i18n@5.1.0
  - @nifrajs/image@5.1.0

## 5.0.0

### Minor Changes

- fc0284a: Add opt-in server components across React, Vue, Svelte, Solid and Preact. Closed schemas project public props, owner GET admission and read capabilities govern every refresh, and private responses bypass shared caches. React uses native Flight; Vue, Svelte, Solid and Preact preserve native island state and owned ranges.

  Add coordinated Vite builds and development generations, guarded component references, generated Bun/Node/Deno/Workers/Pages/Vercel outputs, typed outlets, router and server-function refresh integration, and release certification for browsers, packaged consumers, resource limits and performance. Existing applications retain their default rendering pipeline.

  Reuse registered Web middleware continuations across requests while retaining request-local state.

### Patch Changes

- Updated dependencies [7169820]
- Updated dependencies [22e3df7]
- Updated dependencies [a0a02f4]
- Updated dependencies [0aed425]
- Updated dependencies [eaf030b]
- Updated dependencies [7de0397]
- Updated dependencies [674c658]
- Updated dependencies [de27557]
- Updated dependencies [2173644]
- Updated dependencies [4d894b0]
- Updated dependencies [61901cd]
- Updated dependencies [5e366e2]
- Updated dependencies [2938a0d]
- Updated dependencies [dc8439c]
- Updated dependencies [b19cb37]
- Updated dependencies [4330e40]
- Updated dependencies [4199ff3]
- Updated dependencies [90d9ee6]
- Updated dependencies [364a234]
- Updated dependencies [c06cba5]
- Updated dependencies [f4d3852]
- Updated dependencies [4a82ae0]
- Updated dependencies [0ff867a]
- Updated dependencies [e7391bf]
- Updated dependencies [0b80a59]
- Updated dependencies [c64db12]
- Updated dependencies [3753104]
- Updated dependencies [4b3b1fa]
- Updated dependencies [3562557]
- Updated dependencies [53087f3]
- Updated dependencies [2def6c7]
- Updated dependencies [b5b5bc3]
- Updated dependencies [22e1777]
- Updated dependencies [3a483cd]
- Updated dependencies [35f52c7]
- Updated dependencies [343cb81]
- Updated dependencies [412a9ee]
- Updated dependencies [65883e5]
- Updated dependencies [0e20529]
- Updated dependencies [d91fd44]
- Updated dependencies [f7e36ec]
- Updated dependencies [262e46d]
- Updated dependencies [b13e071]
- Updated dependencies [944623d]
- Updated dependencies [6d9869d]
- Updated dependencies [077657f]
- Updated dependencies [b9cc68c]
- Updated dependencies [de2cc1d]
- Updated dependencies [a5963cb]
- Updated dependencies [05aac0e]
- Updated dependencies [1a6616f]
- Updated dependencies [ecd738e]
- Updated dependencies [7775c2b]
- Updated dependencies [05587e0]
- Updated dependencies [c75818d]
- Updated dependencies [3db36b3]
- Updated dependencies [7775c2b]
- Updated dependencies [09c47c5]
- Updated dependencies [326caee]
- Updated dependencies [f8e0ed5]
- Updated dependencies [a588c18]
- Updated dependencies [1cdcfe5]
- Updated dependencies [e195fe8]
- Updated dependencies [846e2f6]
- Updated dependencies [55f4fdb]
- Updated dependencies [7775c2b]
- Updated dependencies [d3e79c4]
- Updated dependencies [d922f65]
- Updated dependencies [aadd9fc]
- Updated dependencies [ea16748]
- Updated dependencies [a1eda0a]
- Updated dependencies [fc0284a]
- Updated dependencies [5b22f4d]
- Updated dependencies [1b94593]
- Updated dependencies [9f58295]
- Updated dependencies [2f7299a]
- Updated dependencies [29e62a0]
- Updated dependencies [c613e7d]
- Updated dependencies [5975163]
- Updated dependencies [b9608ac]
- Updated dependencies [7a165de]
- Updated dependencies [4064f36]
- Updated dependencies [d8f11a5]
- Updated dependencies [e9e02cf]
- Updated dependencies [b70b18a]
- Updated dependencies [6f42b38]
- Updated dependencies [870227d]
- Updated dependencies [48aad8c]
- Updated dependencies [2fbb4f0]
- Updated dependencies [1d66252]
- Updated dependencies [a6a6834]
- Updated dependencies [166a6ff]
- Updated dependencies [79be5af]
- Updated dependencies [41050ed]
- Updated dependencies [fc837cb]
- Updated dependencies [bf6eeb0]
- Updated dependencies [5a3c27a]
- Updated dependencies [15a3a66]
- Updated dependencies [b80ce77]
- Updated dependencies [9b971fc]
- Updated dependencies [2577fc7]
- Updated dependencies [9b1acc9]
- Updated dependencies [391ab3c]
- Updated dependencies [3bf7d6b]
- Updated dependencies [7775c2b]
- Updated dependencies [ab1935b]
- Updated dependencies [740109f]
- Updated dependencies [e0a25fe]
- Updated dependencies [3630b6e]
- Updated dependencies [1290c6d]
- Updated dependencies [d0a7d58]
  - @nifrajs/web@5.0.0
  - @nifrajs/core@5.0.0
  - @nifrajs/i18n@5.0.0
  - @nifrajs/image@5.0.0

## 4.0.2

### Patch Changes

- Updated dependencies [fcd6a5b]
  - @nifrajs/web@4.0.2
  - @nifrajs/core@4.0.2
  - @nifrajs/i18n@4.0.2
  - @nifrajs/image@4.0.2

## 4.0.1

### Patch Changes

- Updated dependencies [bbb2b27]
- Updated dependencies [2957acd]
- Updated dependencies [4bd292a]
- Updated dependencies [55e813b]
  - @nifrajs/web@4.0.1
  - @nifrajs/core@4.0.1
  - @nifrajs/i18n@4.0.1
  - @nifrajs/image@4.0.1

## 4.0.0

### Major Changes

- a8b33bc: The Solid and Svelte compiler plugins live on their `/plugin` subpaths, and each adapter root exports only the render adapter.

  - `solidBunPlugin` is imported from `@nifrajs/web-solid/plugin`, matching `@nifrajs/web-svelte/plugin` and `@nifrajs/web-vue/plugin`.
  - `@nifrajs/web-solid` and `@nifrajs/web-svelte` link no build-time or `node:` module, so a server or edge bundle that imports the adapter builds under edge resolve conditions (Cloudflare Workers, Vercel Edge, Deno).
  - Solid site scaffolds import the plugin from the subpath.

  Breaking: `solidBunPlugin` is no longer exported from `@nifrajs/web-solid`, nor `svelteBunPlugin` from `@nifrajs/web-svelte`. `nifra fix --code NF-C005` rewrites those imports.

### Minor Changes

- f70f99b: feat(i18n): selectordinal, fallback catalogs, typed nested catalogs and the locale cookie

  The formatter supports `selectordinal` (`{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}`).
  Inside a `plural` or `selectordinal` case, `#` is now the number in the locale's own format
  (`1,000 items`, `1.000 Artikel`) instead of its plain digits - the output changes for counts of 1,000
  and more and for fractions.

  `createFormatter(locale, messages, options)` takes `fallback` catalogs, tried in order for a key the
  catalog lacks (`locales.chain()` gives the order); `onMissing(key, locale)`, called once per key when
  no catalog has it; and `timeZone` and `numberingSystem` defaults for `d()`, `n()` and `#`. An invalid
  locale, time zone or numbering system throws at creation. Formatters are cached per catalog and
  options, with bounded caches, so per-request values cannot grow memory.

  Catalogs may nest: values are messages, lists or blocks, read with dotted keys (`t("home.title")`); a
  flat key that contains a dot is found first, so flat catalogs work unchanged. `get(key)` returns a list
  or block whole. Lookups read own properties only, and an argument named like an `Object.prototype`
  member renders empty unless passed. Declaring `interface Register { messages: typeof en }` on
  `@nifrajs/i18n` types every `t()` and `get()` key, and other locales' catalogs (`Translation`,
  `PartialMessages`) against that shape.

  `localeCookie(name, locale, { maxAge })` returns the `document.cookie` string for a language switcher,
  byte-identical to the `Set-Cookie` `localeDetector({ persist: true })` writes.

  Every adapter's `<I18nProvider>` takes `fallback`, `onMissing`, `timeZone` and `numberingSystem`, and
  its `messages` prop is checked against the registered catalog type.

- 49f106f: feat(i18n): rich text from catalog messages without HTML

  `rich(formatter, key, tags, vars)` from the new `@nifrajs/i18n/rich` entry formats a message like
  `t()` and turns its `<name>…</name>` and `<name/>` tags into calls to `tags[name]`, returning the
  message as text and whatever the handlers returned. Tags are bare names (no attributes); a tag
  without an own handler keeps its content as text, an unclosed or stray marker stays literal, and
  interpolated values and `#` are never read for tags. `renderRich(renderer, ...)` is the same for a
  UI framework.

  React, Preact, Solid and Vue export `rich(t, key, tags, vars)` from `/i18n`, returning one node
  (each handler receives its tag's content as one node, and `<br/>` renders a `<br>` unless `br` is
  given). Svelte exports `<Rich key tags vars>`, which takes one snippet per tag, and `rich()` for the
  parts array. `t()` is unchanged.

- 0f6babe: feat(web): a route can export a `handle`, and `useMatches()` reports the rendered chain on every adapter.

  ```tsx
  // routes/orgs/[org]/_layout.tsx
  import { useMatches } from "@nifrajs/web-react/router";

  export const handle = { crumb: "Organization" };

  export default function OrgLayout({
    children,
  }: {
    children: React.ReactNode;
  }) {
    const crumbs = useMatches().flatMap(
      (m) => (m.handle as { crumb?: string } | undefined)?.crumb ?? []
    );
    // ...
  }
  ```

  `useMatches()` lists the layouts being rendered, outermost first, then the page, each as
  `{ id, pathname, params, data, handle }`: the route file without its extension, the part of the URL
  it covers (never the query), the params it declares, its loader data (`null` without a loader), and
  its `handle` export. The server render and the browser report the same list, so a breadcrumb trail
  hydrates with no mismatch. `handle` is read from the module on each side and never serialized.

  While a `_loading` page is up it takes the page's place; a nested `_404` reports the layouts it
  renders inside; an `_error` page the server renders reports an empty list. The hook ships from each
  adapter's `/router` entry: an array on React and Preact, a `Ref` on Vue, an accessor on Solid and
  Svelte. An app that never calls it does not bundle it.

  The Preact, Solid, Vue and Svelte client mounts now pass `params` and `path` to the rendered chain,
  as the server render already did. `UIMatch` and `MatchChain` are exported from `@nifrajs/web`.

### Patch Changes

- 085e852: On the Bun dev pipeline, an error thrown from a `.vue` or `.svelte` file names the line written in that file, in the browser and on the server: the overlay, the in-page badge, `nifra errors` and the fix prompts all point there.

  - `vueBunPlugin` and `svelteBunPlugin` attach their compile map while a dev server runs; `nifra build` output is unchanged.
  - `@nifrajs/web/plugins/kit` exports `withDevSourceMap` and `concatSourceMaps` for other compiler plugins to do the same.
  - Svelte's `hydration_html_changed` and `hydration_attribute_changed` warnings count as hydration mismatches. Vue's feature-flag warning, which names `__VUE_PROD_HYDRATION_MISMATCH_DETAILS__`, does not.

- ee19d29: fix(web-react, web-preact, web-vue, web-solid, web-svelte): a layout keeps its loader data in the
  browser. The mounted router rendered every layout with `data: null` - on the first paint, where the
  server had rendered the layout with its data and the client render no longer matched it, and after
  each client navigation. It now hands each layout the data the router holds for it. On Solid a layout
  also follows a same-route update, so new layout data after a revalidation or a param change arrives
  without the layout remounting.
- d6f806f: An `*.svg?component` import compiles its file as markup only, for every framework:

  - JSX (React, Preact, Solid) spells braces, `>` and `=` in text and CDATA as character references. An exported stylesheet (`.st0{fill:#FFF}`, `a > b`) now compiles, and text such as `{...}` in a `<title>` renders as written.
  - Svelte spells braces in text and attribute values as character references, keeps a nested `<style>` or `<script>` as raw text, and refuses a directive attribute (`use:`, `on:`, `bind:`...) or a `svelte:` element.
  - Vue marks the root `v-pre`, so `{{ }}`, `:bound` and `v-` attributes are not compiled. A `<template>` tag is refused.
  - The file must be one well-formed `<svg>` element, with every attribute value quoted and nothing after the root. Anything else fails the build with a message naming the problem. The check is exported as `svgTemplateMarkup()`.

- Updated dependencies [dde125b]
- Updated dependencies [22e2af8]
- Updated dependencies [72b62fa]
- Updated dependencies [aa44e93]
- Updated dependencies [4a3ee60]
- Updated dependencies [963694f]
- Updated dependencies [aad6297]
- Updated dependencies [dad0d41]
- Updated dependencies [538adc2]
- Updated dependencies [f47edd1]
- Updated dependencies [df9530a]
- Updated dependencies [3e6973f]
- Updated dependencies [25e8edf]
- Updated dependencies [2b5e5fc]
- Updated dependencies [3b090de]
- Updated dependencies [da7d792]
- Updated dependencies [612a296]
- Updated dependencies [fb14dfa]
- Updated dependencies [8ae97f6]
- Updated dependencies [4af6f39]
- Updated dependencies [ca8b50d]
- Updated dependencies [b00a889]
- Updated dependencies [b53d64f]
- Updated dependencies [66fd712]
- Updated dependencies [9c3d524]
- Updated dependencies [738e7a1]
- Updated dependencies [4801cac]
- Updated dependencies [1b2d53a]
- Updated dependencies [25fe13d]
- Updated dependencies [0852290]
- Updated dependencies [0589dbe]
- Updated dependencies [2e2d8c0]
- Updated dependencies [856f5ce]
- Updated dependencies [18aa5aa]
- Updated dependencies [cfd86b3]
- Updated dependencies [8ff96c9]
- Updated dependencies [4c46199]
- Updated dependencies [eef4932]
- Updated dependencies [6de8686]
- Updated dependencies [86e2d0f]
- Updated dependencies [a0cfffa]
- Updated dependencies [d7892ea]
- Updated dependencies [93e5e7f]
- Updated dependencies [214d674]
- Updated dependencies [4936309]
- Updated dependencies [ff5a779]
- Updated dependencies [772249a]
- Updated dependencies [f70f99b]
- Updated dependencies [49f106f]
- Updated dependencies [4936309]
- Updated dependencies [def0172]
- Updated dependencies [fc2f019]
- Updated dependencies [a734fba]
- Updated dependencies [0e9b167]
- Updated dependencies [bbdc5a1]
- Updated dependencies [10bc446]
- Updated dependencies [e8270d9]
- Updated dependencies [d942c33]
- Updated dependencies [ef28ef9]
- Updated dependencies [ff4a062]
- Updated dependencies [43ba944]
- Updated dependencies [46c741a]
- Updated dependencies [7bfa25e]
- Updated dependencies [216fe27]
- Updated dependencies [4936309]
- Updated dependencies [6e257a6]
- Updated dependencies [4a03d30]
- Updated dependencies [8e30090]
- Updated dependencies [28f3aaf]
- Updated dependencies [6d20355]
- Updated dependencies [08250bf]
- Updated dependencies [6907cbe]
- Updated dependencies [4b8d8de]
- Updated dependencies [ba5dd1c]
- Updated dependencies [d50f73e]
- Updated dependencies [031c33d]
- Updated dependencies [8fa902c]
- Updated dependencies [085e852]
- Updated dependencies [0dac7ec]
- Updated dependencies [b64c3ee]
- Updated dependencies [dc2d4d3]
- Updated dependencies [bda9637]
- Updated dependencies [81c720e]
- Updated dependencies [ed60b23]
- Updated dependencies [0150ed4]
- Updated dependencies [ae815ab]
- Updated dependencies [ea2ee87]
- Updated dependencies [3442e1c]
- Updated dependencies [85d636b]
- Updated dependencies [6c978a1]
- Updated dependencies [bfe29b6]
- Updated dependencies [8b99424]
- Updated dependencies [87783f0]
- Updated dependencies [135aba4]
- Updated dependencies [47b0d65]
- Updated dependencies [e32268d]
- Updated dependencies [432fec3]
- Updated dependencies [0e14068]
- Updated dependencies [8f1b780]
- Updated dependencies [dcc9ff6]
- Updated dependencies [5a63dd4]
- Updated dependencies [c49882f]
- Updated dependencies [dfd19d8]
- Updated dependencies [28e091f]
- Updated dependencies [046e79d]
- Updated dependencies [6393b1e]
- Updated dependencies [a158b74]
- Updated dependencies [ee19d29]
- Updated dependencies [293d3c8]
- Updated dependencies [7e1e1c3]
- Updated dependencies [0cd5f6e]
- Updated dependencies [2245bee]
- Updated dependencies [feeec4a]
- Updated dependencies [3eb6339]
- Updated dependencies [f784c32]
- Updated dependencies [e3b2b97]
- Updated dependencies [5934b5d]
- Updated dependencies [03a3729]
- Updated dependencies [bd11269]
- Updated dependencies [579d9a9]
- Updated dependencies [3554ad8]
- Updated dependencies [64e7a42]
- Updated dependencies [ee19d29]
- Updated dependencies [d6f806f]
- Updated dependencies [38cf032]
- Updated dependencies [b94e5cb]
- Updated dependencies [0f6babe]
- Updated dependencies [00f18bf]
- Updated dependencies [a84f546]
- Updated dependencies [669b6a2]
- Updated dependencies [ff25d68]
  - @nifrajs/core@4.0.0
  - @nifrajs/web@4.0.0
  - @nifrajs/i18n@4.0.0
  - @nifrajs/image@4.0.0

## 3.5.0

### Patch Changes

- Updated dependencies [6046984]
- Updated dependencies [ac27343]
- Updated dependencies [d5b7c22]
  - @nifrajs/core@3.5.0
  - @nifrajs/web@3.5.0
  - @nifrajs/image@3.5.0
  - @nifrajs/i18n@3.5.0

## 3.4.0

### Patch Changes

- 8d23613: Add the opt-in `@nifrajs/webmcp` package: typed WebMCP registration, core-backed receipts, deterministic predictive-UI reconciliation, and host-independent conformance checks. Also tighten agent execution cancellation cleanup so aborted local work cannot leak into later turns.
- Updated dependencies [8d23613]
- Updated dependencies [8d23613]
- Updated dependencies
- Updated dependencies [719d82e]
  - @nifrajs/web@3.4.0
  - @nifrajs/core@3.4.0
  - @nifrajs/i18n@3.4.0
  - @nifrajs/image@3.4.0

## 3.3.0

### Patch Changes

- @nifrajs/core@3.3.0
- @nifrajs/i18n@3.3.0
- @nifrajs/image@3.3.0
- @nifrajs/web@3.3.0

## 3.2.0

### Patch Changes

- 469b998: Fix Windows path handling in the TypeScript route plugin and Svelte/Vue build plugins, including file-URL inputs, virtual stylesheet modules, and platform-neutral generated output.
- Updated dependencies [652201a]
- Updated dependencies [3aefb12]
- Updated dependencies [8b58d1f]
- Updated dependencies [c4ed8f7]
- Updated dependencies [25305bb]
- Updated dependencies [095c320]
- Updated dependencies [7504864]
- Updated dependencies [e88c23a]
- Updated dependencies [c39712e]
- Updated dependencies [9010fd3]
- Updated dependencies [7551709]
- Updated dependencies [ea2356e]
- Updated dependencies [a816b87]
  - @nifrajs/web@3.2.0
  - @nifrajs/core@3.2.0
  - @nifrajs/image@3.2.0
  - @nifrajs/i18n@3.2.0

## 3.1.0

### Patch Changes

- 8b136ee: Framework bindings now share consistent query and fetcher idle behavior while keeping mounted-router state isolated per adapter.
- Updated dependencies [5b78473]
- Updated dependencies [1400f6c]
- Updated dependencies [8b136ee]
- Updated dependencies [a7db515]
  - @nifrajs/core@3.1.0
  - @nifrajs/i18n@3.1.0
  - @nifrajs/web@3.1.0
  - @nifrajs/image@3.1.0

## 3.0.0

### Patch Changes

- 86a555b: The roadmap contract surfaces are now shipped across the public packages: shared island triggers,
  typed content indexes and joins, client loader/action hooks, and unified static, dynamic, and
  intercepting boundary modes. WebSocket routes also support opt-in synchronous outbound validation
  through `sendSchema` + `validateSend`; invalid or asynchronous outbound frames fail closed while the
  default remains type-level only.
- Updated dependencies [f3d2a35]
- Updated dependencies [6e43c15]
- Updated dependencies [293a7fe]
- Updated dependencies [485ae60]
- Updated dependencies [627b0ba]
- Updated dependencies [f0fd370]
- Updated dependencies [004deee]
- Updated dependencies [86a555b]
- Updated dependencies [8c5f4cf]
- Updated dependencies [f0fd370]
- Updated dependencies [381bbf3]
- Updated dependencies [36801ae]
- Updated dependencies [9acadba]
- Updated dependencies [99fc683]
- Updated dependencies [73d894d]
  - @nifrajs/core@3.0.0
  - @nifrajs/web@3.0.0
  - @nifrajs/i18n@3.0.0
  - @nifrajs/image@3.0.0

## 2.14.1

### Patch Changes

- Updated dependencies [bf93902]
  - @nifrajs/core@2.14.1
  - @nifrajs/i18n@2.14.1
  - @nifrajs/web@2.14.1
  - @nifrajs/image@2.14.1

## 2.14.0

### Patch Changes

- Updated dependencies [489c6b6]
- Updated dependencies [701961a]
- Updated dependencies [62e22e2]
- Updated dependencies [62e22e2]
- Updated dependencies [62133bf]
- Updated dependencies [8dffdf4]
- Updated dependencies [489c6b6]
  - @nifrajs/web@2.14.0
  - @nifrajs/core@2.14.0
  - @nifrajs/i18n@2.14.0
  - @nifrajs/image@2.14.0

## 2.13.0

### Patch Changes

- Updated dependencies [e0b2dd6]
- Updated dependencies [7535ce1]
- Updated dependencies [1704308]
- Updated dependencies [6510fdc]
  - @nifrajs/core@2.13.0
  - @nifrajs/web@2.13.0
  - @nifrajs/i18n@2.13.0
  - @nifrajs/image@2.13.0

## 2.12.1

### Patch Changes

- Updated dependencies [fba30c7]
  - @nifrajs/core@2.12.1
  - @nifrajs/i18n@2.12.1
  - @nifrajs/web@2.12.1
  - @nifrajs/image@2.12.1

## 2.12.0

### Patch Changes

- a5d3f5b: Add stable diagnostic codes, application-supplied rule packs, fix recipes, assurance bundles, contract lock snapshots, hydration assurance hooks, replay metadata, security verification rules, and idempotency proofs.
- Updated dependencies [df100d3]
- Updated dependencies [0efacea]
- Updated dependencies [cd1732c]
- Updated dependencies [df100d3]
- Updated dependencies [9a9346e]
- Updated dependencies [b5f47c0]
- Updated dependencies [fc33c0f]
- Updated dependencies [fa51aba]
- Updated dependencies [c4e8bb0]
- Updated dependencies [11d1658]
- Updated dependencies [33ee9ff]
- Updated dependencies [ceda72d]
- Updated dependencies [2c004ca]
- Updated dependencies [5f71c23]
- Updated dependencies [3788b36]
- Updated dependencies [0863ef0]
- Updated dependencies [ae5338f]
- Updated dependencies [8847825]
- Updated dependencies [9a9346e]
- Updated dependencies [4c2123d]
- Updated dependencies [5e4e31a]
- Updated dependencies [24f1787]
- Updated dependencies [9a9346e]
- Updated dependencies [b045f9e]
- Updated dependencies [df07059]
- Updated dependencies [9a9346e]
- Updated dependencies [9a9346e]
- Updated dependencies [dbc0b79]
- Updated dependencies [bd5c624]
- Updated dependencies [a5d3f5b]
- Updated dependencies [00819c5]
- Updated dependencies [e2bdd4a]
- Updated dependencies [e2d1939]
- Updated dependencies [e83e6eb]
- Updated dependencies [64d25db]
- Updated dependencies [c55f7a3]
- Updated dependencies [f8b0097]
  - @nifrajs/core@2.12.0
  - @nifrajs/i18n@2.12.0
  - @nifrajs/web@2.12.0
  - @nifrajs/image@2.12.0

## 2.11.0

### Minor Changes

- ed5e91c: Vue, Solid and Svelte hot-patch a component edit in place on the Bun dev pipeline: the page keeps its scroll position, its open dialogs and the rest of its client state, and only the edited component re-renders. Route modules still full-reload on save, since a route carries the loader and meta the server ran. The wiring is emitted for a dev server's client compile only, so nothing reaches a production bundle.

  `@nifrajs/web-svelte/plugin` adds `svelteHmrBoundary`, the same boundary for the Vite pipeline - pass it to `@sveltejs/vite-plugin-svelte` as `dynamicCompileOptions`. Svelte's hot-patch wrapper resolves a component through a signal, which reconciles against server markup only where the component is a plain child in a template; a layout or a page is neither, and wrapping one desyncs hydration on first load. The boundary keeps the wrapper on the app's own views. (Svelte recreates the patched component, so its own `$state` restarts - Vue and Solid preserve theirs.)

  `Router.svelte` now takes `searchOfChain` from `@nifrajs/web/client` rather than the package root, so a client bundle no longer reaches server-only modules through it.

### Patch Changes

- 30f5ea3: SSR renders the code that is on disk on the Bun dev pipeline, not just for route files. An edit to anything a route imports - a component, a helper, a `*.server` module, at any depth - now reaches the server-rendered HTML on the next request, so a saved change no longer shows up on the client while the SSR pass still renders the version the server started with. All four frameworks, and both `import "./Counter"` and `import "./Counter.tsx"`.

  A module nobody edited keeps its identity, so a database client or any other module-scope singleton shared between the backend and a route is still a single instance; editing that module deliberately gives the routes the new code. The Vite pipeline is unchanged - it already owned an SSR module graph.

  `@nifrajs/web/plugins/kit` adds `rewriteSsrImports`, which a plugin that compiles its own file type passes its `generate: "ssr"` output through - the compiling plugin is the only code that sees that file's imports, so it is the only place they can be re-keyed.

- c29e0d0: Svelte runs on the Vite pipeline. `nifra dev` and `nifra build` now serve and build a Svelte app on either bundler, so a Svelte app is no longer the one framework pinned to a single pipeline, and pages render with routing context, typed search and layout data intact on both.

  `@nifrajs/web` adds `setSsrModuleLoader` / `ssrModuleLoader`, the seam that makes it work. A dev server that owns SSR resolution publishes its module loader; a render adapter that has to load a compiled asset on the server reads it and loads through it, so that asset is compiled by the same toolchain as the app's routes and renders through the same copy of the framework runtime. Adapters that ship no compiled assets are unaffected.

  `conditions` on the Bun dev pipeline reaches SSR, and says so when it cannot reach the client bundle Bun's dev server serves - a one-line startup notice instead of a package that quietly resolves to one file in dev and another in `nifra build`.

  CSS Modules class names are now identical on both pipelines. The same class hashes to the same scoped name under `nifra dev`, `nifra dev --bun` and `nifra build`, so a selector written against a generated name behaves the same everywhere.

  The dev-and-HMR guide gains a Gotchas section covering the config/adapter file split, plugin slots, resolve conditions, non-route SSR freshness, and the adapter loader.

- Updated dependencies [ed5e91c]
- Updated dependencies [30f5ea3]
- Updated dependencies [c29e0d0]
  - @nifrajs/web@2.11.0
  - @nifrajs/core@2.11.0
  - @nifrajs/i18n@2.11.0
  - @nifrajs/image@2.11.0

## 2.10.0

### Patch Changes

- Updated dependencies [5263c4e]
- Updated dependencies [15bffdd]
- Updated dependencies [15bffdd]
- Updated dependencies [15bffdd]
  - @nifrajs/web@2.10.0
  - @nifrajs/core@2.10.0
  - @nifrajs/image@2.10.0
  - @nifrajs/i18n@2.10.0

## 2.9.1

### Patch Changes

- Updated dependencies [01e36fb]
  - @nifrajs/core@2.9.1
  - @nifrajs/web@2.9.1
  - @nifrajs/i18n@2.9.1
  - @nifrajs/image@2.9.1

## 2.9.0

### Patch Changes

- Updated dependencies [e05e56d]
  - @nifrajs/core@2.9.0
  - @nifrajs/web@2.9.0
  - @nifrajs/i18n@2.9.0
  - @nifrajs/image@2.9.0

## 2.8.2

### Patch Changes

- Updated dependencies [f7d68e8]
  - @nifrajs/core@2.8.2
  - @nifrajs/image@2.8.2
  - @nifrajs/web@2.8.2
  - @nifrajs/i18n@2.8.2

## 2.8.1

### Patch Changes

- Updated dependencies [78d66a4]
- Updated dependencies [93fdc89]
  - @nifrajs/core@2.8.1
  - @nifrajs/web@2.8.1
  - @nifrajs/i18n@2.8.1
  - @nifrajs/image@2.8.1

## 2.8.0

### Patch Changes

- Updated dependencies [118e4a5]
  - @nifrajs/web@2.8.0
  - @nifrajs/core@2.8.0
  - @nifrajs/i18n@2.8.0
  - @nifrajs/image@2.8.0

## 2.7.1

### Patch Changes

- Updated dependencies [52c89e0]
  - @nifrajs/core@2.7.1
  - @nifrajs/web@2.7.1
  - @nifrajs/i18n@2.7.1
  - @nifrajs/image@2.7.1

## 2.7.0

### Patch Changes

- @nifrajs/core@2.7.0
- @nifrajs/i18n@2.7.0
- @nifrajs/image@2.7.0
- @nifrajs/web@2.7.0

## 2.6.1

### Patch Changes

- Updated dependencies [5840c98]
- Updated dependencies [80419f5]
  - @nifrajs/core@2.6.1
  - @nifrajs/web@2.6.1
  - @nifrajs/i18n@2.6.1
  - @nifrajs/image@2.6.1

## 2.6.0

### Patch Changes

- e6349e5: Security hardening across input parsing and code generation. Every regex that runs on caller-influenced input (URL paths, route patterns, stylesheet and SVG sources, manifest text) is now linear - no polynomial backtracking on adversarial input. SVG preamble stripping and tag removal can no longer splice removed delimiters into new markers. Static file serving rejects `..` traversal in the request form outright and confines the resolved path with a `relative()` containment check. Generated code embeds strings through an escaper that neutralizes `</script>` breakout and the U+2028/U+2029 line separators, and HTML entity decoding resolves `&amp;` last so double-encoded entities cannot double-unescape.
- Updated dependencies [e6349e5]
- Updated dependencies [08fe221]
- Updated dependencies [8383063]
  - @nifrajs/web@2.6.0
  - @nifrajs/core@2.6.0
  - @nifrajs/i18n@2.6.0
  - @nifrajs/image@2.6.0

## 2.5.0

### Patch Changes

- Updated dependencies [02d9aa8]
  - @nifrajs/web@2.5.0
  - @nifrajs/core@2.5.0
  - @nifrajs/i18n@2.5.0
  - @nifrajs/image@2.5.0

## 2.4.0

### Patch Changes

- Updated dependencies [1c2bf5a]
- Updated dependencies [138bfba]
- Updated dependencies [23e6eb1]
  - @nifrajs/web@2.4.0
  - @nifrajs/core@2.4.0
  - @nifrajs/i18n@2.4.0
  - @nifrajs/image@2.4.0

## 2.3.0

### Minor Changes

- 2d9beaa: Preact, Vue, Solid and Svelte gain `useNavigate` and `useBlocker`, from `@nifrajs/web-<framework>/router`.

  `useNavigate` returns a programmatic navigate (a path pushes or replaces; a number is a history delta),
  matching the React adapter. `useBlocker` is the unsaved-changes guard - pass a boolean or a
  `({ currentLocation, nextLocation }) => boolean` predicate and get back a `{ state, proceed, reset }`
  value in each framework's own reactive shape (a Vue ref, a Solid accessor, a Svelte store, a plain value
  in Preact). When a navigation is intercepted, `state` becomes `"blocked"`; show your own confirmation and
  call `proceed()` or `reset()`. It also arms the native "Leave site?" prompt on tab close and reload.

  ```svelte
  <script>
    import { useBlocker } from "@nifrajs/web-svelte/router"
    let dirty = false
    const blocker = useBlocker(() => dirty)
  </script>

  {#if $blocker.state === "blocked"}
    <dialog open>
      <button on:click={$blocker.reset}>Keep editing</button>
      <button on:click={$blocker.proceed}>Discard</button>
    </dialog>
  {/if}
  ```

  In Vue, Solid and Svelte the hook is created once, so pass a function to track a changing flag
  (`useBlocker(() => dirty)`); a bare boolean is captured as-is. The guarding itself already ran on every
  adapter at the browser layer - this exposes it as a reactive hook.

- c823915: Typed, validated search params: a route declares a `searchSchema` and both its loader and its component read the parsed, validated query.

  Export a Standard Schema as `searchSchema` from a route. The loader's `ctx.search` becomes the parsed URL query validated against it (typed via `LoaderArgs<typeof app, Env, typeof searchSchema>`), and the component reads the same value with `useSearch<typeof searchSchema>()`. Invalid or hostile input fails closed to the schema's defaults (never a 500); without a `searchSchema`, both are the raw parsed query. Validation runs at match time and the value is derived identically on the server and on client navigation, so a component never parses `window.location.search` by hand and the query it renders hydrates with no mismatch.

  ```tsx
  export const searchSchema = v.object({
    page: v.optional(v.fallback(v.number(), 1), 1),
  });

  export async function loader({
    search,
    api,
  }: LoaderArgs<typeof backend, unknown, typeof searchSchema>) {
    return { rows: await api.reports.list(search).get() }; // search.page is a number
  }

  export default function Reports({ data }) {
    const { page } = useSearch<typeof searchSchema>(); // page: number, SSR-correct
    return <Pager page={page} />;
  }
  ```

  A `_layout` can declare its own `searchSchema` for keys shared across a section (`?org`, `?theme`); the route's effective search merges the layout chain's schemas with the page's, page-wins on a conflict, so both the layout and the page read their validated slice from one object.

  A route can also list `searchClientKeys` - search keys that are purely client-side UI (`?tab`, a client-side `?sort`, `?modal`). When a client navigation changes only those keys, the URL updates (so `useSearch` re-renders) without re-running the loader; any other key change revalidates as before, so data is never stale.

  `useSearch` ships on every adapter - React (a value), Preact (a value), Vue (a `Ref`), Solid (an `Accessor`), and Svelte (an accessor), each in that framework's own shape.

  `navigate` gains an object form on every adapter: `navigate({ to, search, replace })` serializes `search` onto `to` (no hand-built query strings). Run `nifra sync-routes` to generate `nifra-routes.d.ts` (each static route mapped to its schema output) and include it in your tsconfig, and `search` is typed against the target route's `searchSchema` - a wrong shape for a known route is a compile error, while an unmapped path takes a loose `search`. Regenerated from the route files, so a stale shape becomes a `tsc` error. The string-path and history-delta forms are unchanged.

  ```ts
  navigate({ to: "/reports", search: { page: 2 } }); // search typed against /reports's schema
  ```

- 62a8d03: Add `useServerFn` - a server function's pending, data and error state - to all five adapters.

  ```tsx
  const addTodo = useServerFn(fns.addTodo)
  <button disabled={addTodo.pending} onClick={() => addTodo.call({ text }).catch(() => {})}>add</button>
  ```

  Calling a server function never needed a binding: the client stub is `(input) => Promise<Output>`.
  This adds only the state a component wants around it.

  The state machine is `@nifrajs/web`'s `createServerFnStore`, shared by every adapter, so "is it
  pending" has one answer rather than five that drift. Each binding contributes just its subscription
  primitive: `useSyncExternalStore` (React, Preact), a signal (Solid), a `shallowRef` (Vue), a `readable`
  (Svelte).

  Two behaviours worth knowing:

  - **The last call wins.** A response that is no longer the newest is discarded rather than written, so
    a slow first call landing after a fast second cannot overwrite fresh data with stale.
  - **`call` still rejects.** The error is recorded for rendering AND the promise rejects, so `await`
    behaves normally. A caller that only renders from state should attach `.catch(() => {})`, as with
    `useFetcher`'s `submit`.

  `data` is kept while the next call is in flight, so a rendered list does not blank on every refetch.

### Patch Changes

- ea0a27f: A server function has one type per half, so both the server call and the hook argument are honest.

  ```ts
  export type ClientServerFn<Input, Output> = (
    input: Input
  ) => MaybePromise<Output>;
  export type ServerFnReference<Input, Output> =
    | ServerFn<Input, Output>
    | ClientServerFn<Input, Output>;
  ```

  One type could not describe both halves. `ServerFn` is the SERVER declaration and takes `(input,
context)`; the client imports a generated stub that takes one argument. Widening the single type so a
  one-argument call compiled made a direct server call type-check while handing the declaration
  `undefined` for a context its implementation requires - a runtime failure the compiler had just been
  told to allow.

  Now the two are separate and `useServerFn` accepts either through `ServerFnReference`, which is the
  one place the two halves legitimately meet. Calling a declaration from your own server code needs the
  context, and omitting it is a compile error again.

- 4f8c0cc: `useServerFn`'s store reports the current state to a late subscriber.

  Svelte's `readable` runs its start function only on the FIRST subscription, and this one subscribed
  without priming - so a store read after a call had already finished reported its initial value, idle,
  for a call that succeeded. It hits a handle created at module scope, one shared through a Svelte
  context, and any component that mounts after the call.

  It now sets `store.snapshot()` before subscribing, matching `useFetcher` in this same package. The
  other four adapters already read a snapshot on mount, so this was the one place where "is it pending"
  gave a different answer from the shared state machine it exists to report.

- Updated dependencies [6f5b3ad]
- Updated dependencies [85b354d]
- Updated dependencies [7293a1c]
- Updated dependencies [8514caa]
- Updated dependencies [ea0a27f]
- Updated dependencies [ea0a27f]
- Updated dependencies [45b0733]
- Updated dependencies [c42d777]
- Updated dependencies [ea0a27f]
- Updated dependencies [b271164]
- Updated dependencies [8c77d47]
- Updated dependencies [ea0a27f]
- Updated dependencies [ea0a27f]
- Updated dependencies [d190b1c]
- Updated dependencies [a4ecca9]
- Updated dependencies [de8d992]
- Updated dependencies [a92104e]
- Updated dependencies [5fe332a]
- Updated dependencies [c823915]
- Updated dependencies [d2840ac]
- Updated dependencies [62a8d03]
- Updated dependencies [dcacfe7]
- Updated dependencies [28704d7]
- Updated dependencies [ea0a27f]
- Updated dependencies [0c2de22]
  - @nifrajs/core@2.3.0
  - @nifrajs/web@2.3.0
  - @nifrajs/i18n@2.3.0
  - @nifrajs/image@2.3.0

## 2.2.0

### Minor Changes

- 1394641: Layout loaders: request data in the component that wraps every page.

  `routes/_layout.tsx` rendered, but a `loader` it exported never ran, so nothing request-derived could
  reach a layout - host, session, locale, feature flags, tenant. An app hit this and moved its host guard
  out of the component tree into the server entry, where it could not be typechecked with the rest of the
  app. That is the real cost: the gap pushed security-relevant code to the one place nifra's typed-boundary
  promise does not reach. Remix, React Router and SvelteKit all support this; nifra was alone in not.

  ```tsx
  // routes/orgs/[org]/_layout.tsx
  export const gate = true                       // optional; see below
  export async function loader({ params, req }) {
    return { org: await findOrg(params.org) }    // params is { org } - nothing deeper
  }
  export default function Layout({ data, children }) { … }
  ```

  **Scoped, not global.** A layout owns the URL prefix it wraps, so it receives only the params inside
  that prefix and its loader is skipped on a navigation that did not change them. Navigating
  `/orgs/acme/a` → `/orgs/acme/b` does not re-run the org layout's loader. Scope is derived at build time
  per `(route, layout)` pair, because one layout can own different params on different expanded patterns:
  `[[lang]]/docs/_layout` owns nothing on `/docs/:slug` and `{lang}` on `/:lang/docs/:slug`. Layouts are
  not router nodes and did not become any - the router is untouched.

  **Execution order is declared, and this matters for security.** By default a layout loader runs in
  parallel with the page's, which is right for data and wrong for a guard: a page loader running
  concurrently with a guard has already queried by the time the guard says no. `export const gate = true`
  makes a layout blocking - nothing beneath it runs until it resolves, and nothing beneath a rejected gate
  runs at all. **A layout loader without `gate: true` is not an authorization boundary.** Gates also run on
  the data-only request, so a client navigation cannot bypass one by sending the data header, and a gate is
  never skipped by the retention hint.

  A layout may throw `notFound()` / `gone()` / `redirect()`. Its errors resolve to the `_error` boundary at
  or above its OWN segment, never one below it - rendering there would wrap the boundary in the very layout
  whose loader just failed.

  Every adapter passes each layout its own data. A layout with no loader receives `null`, and an app where
  no layout has a loader emits byte-identical HTML and unchanged props.

  The data-mode response becomes a versioned envelope when a chain carries layout data. It is recognised
  by structure, and the bare pre-envelope shape is still accepted - a prerendered `_data.json` is a static
  file that outlives the deploy that wrote it.

### Patch Changes

- Updated dependencies [39b1670]
- Updated dependencies [d428f52]
- Updated dependencies [135d0c6]
- Updated dependencies [1394641]
- Updated dependencies [e713cab]
- Updated dependencies [a4645e2]
- Updated dependencies [a7d740a]
- Updated dependencies [6e996a1]
- Updated dependencies [15ad6ca]
- Updated dependencies [6aa0aac]
- Updated dependencies [1857d39]
- Updated dependencies [6ba3173]
- Updated dependencies [ca71a2e]
- Updated dependencies [0fc215b]
- Updated dependencies [2ff661f]
- Updated dependencies [a1327a4]
- Updated dependencies [2500705]
  - @nifrajs/web@2.2.0
  - @nifrajs/i18n@2.2.0
  - @nifrajs/image@2.2.0

## 2.1.0

### Patch Changes

- Updated dependencies [bd294bb]
  - @nifrajs/web@2.1.0
  - @nifrajs/i18n@2.1.0
  - @nifrajs/image@2.1.0

## 2.0.0

### Minor Changes

- 3620546: Extend `import Icon from "./icon.svg?component"` to the Solid, Svelte, and Vue adapters (`@nifrajs/web-solid/svg`, `@nifrajs/web-svelte/svg`, `@nifrajs/web-vue/svg`), joining the React/Preact plugin.

  Each is a Bun build plugin that turns a `?component` SVG import into a framework component with the caller's props/attrs spread onto the root `<svg>`, using that framework's own compiler: Solid emits `class`-form JSX through `babel-preset-solid`; Svelte wraps the raw SVG in a Svelte 5 component (compiled by `svelte/compiler`); Vue wraps it in a single-root template so Vue's attribute inheritance forwards props to the `<svg>` (compiled by `@vue/compiler-sfc`). A plain `import "./icon.svg"` asset URL is untouched - only `?component` is intercepted. The shared `svgToJsx` transform gained a `classProp` option.

### Patch Changes

- Updated dependencies [ade0c7a]
- Updated dependencies [d91a45b]
- Updated dependencies [d91a45b]
- Updated dependencies [e97a92f]
- Updated dependencies [e8e49d1]
- Updated dependencies [a7d34e5]
  - @nifrajs/web@2.0.0
  - @nifrajs/i18n@2.0.0
  - @nifrajs/image@2.0.0

## 1.13.0

### Patch Changes

- Updated dependencies [5b6127a]
  - @nifrajs/web@1.13.0
  - @nifrajs/i18n@1.13.0
  - @nifrajs/image@1.13.0

## 1.12.0

### Patch Changes

- @nifrajs/web@1.12.0
- @nifrajs/i18n@1.12.0
- @nifrajs/image@1.12.0

## 1.11.0

### Patch Changes

- Updated dependencies [5638ada]
  - @nifrajs/web@1.11.0
  - @nifrajs/i18n@1.11.0
  - @nifrajs/image@1.11.0

## 1.10.0

### Patch Changes

- @nifrajs/web@1.10.0
- @nifrajs/i18n@1.10.0
- @nifrajs/image@1.10.0

## 1.9.1

### Patch Changes

- Updated dependencies [3eb27ae]
  - @nifrajs/web@1.9.1
  - @nifrajs/i18n@1.9.1
  - @nifrajs/image@1.9.1

## 1.9.0

### Patch Changes

- Updated dependencies [0e1b4cc]
- Updated dependencies [6b67833]
  - @nifrajs/web@1.9.0
  - @nifrajs/i18n@1.9.0
  - @nifrajs/image@1.9.0

## 1.8.0

### Patch Changes

- Updated dependencies [1ffd48b]
  - @nifrajs/web@1.8.0
  - @nifrajs/i18n@1.8.0
  - @nifrajs/image@1.8.0

## 1.7.0

### Patch Changes

- Updated dependencies [9f23e90]
  - @nifrajs/web@1.7.0
  - @nifrajs/i18n@1.7.0
  - @nifrajs/image@1.7.0

## 1.6.0

### Patch Changes

- @nifrajs/i18n@1.6.0
- @nifrajs/image@1.6.0
- @nifrajs/web@1.6.0

## 1.5.0

### Patch Changes

- @nifrajs/web@1.5.0
- @nifrajs/i18n@1.5.0
- @nifrajs/image@1.5.0

## 1.4.0

### Patch Changes

- Updated dependencies [4d25970]
  - @nifrajs/web@1.4.0
  - @nifrajs/i18n@1.4.0
  - @nifrajs/image@1.4.0

## 1.3.1

### Patch Changes

- @nifrajs/i18n@1.3.1
- @nifrajs/image@1.3.1
- @nifrajs/web@1.3.1

## 1.3.0

### Patch Changes

- Updated dependencies [4a4b1c4]
  - @nifrajs/web@1.3.0
  - @nifrajs/i18n@1.3.0
  - @nifrajs/image@1.3.0

## 1.2.2

### Patch Changes

- @nifrajs/i18n@1.2.2
- @nifrajs/image@1.2.2
- @nifrajs/web@1.2.2

## 1.2.1

### Patch Changes

- Updated dependencies [c3ebd73]
  - @nifrajs/web@1.2.1
  - @nifrajs/i18n@1.2.1
  - @nifrajs/image@1.2.1

## 1.2.0

### Patch Changes

- @nifrajs/web@1.2.0
- @nifrajs/i18n@1.2.0
- @nifrajs/image@1.2.0

## 1.1.0

### Patch Changes

- Updated dependencies [37d2383]
  - @nifrajs/web@1.1.0
  - @nifrajs/i18n@1.1.0
  - @nifrajs/image@1.1.0

## 1.0.0

### Patch Changes

- Updated dependencies [f1f0e18]
  - @nifrajs/web@1.0.0
  - @nifrajs/i18n@1.0.0
  - @nifrajs/image@1.0.0

## 1.0.0-beta.4

### Patch Changes

- @nifrajs/i18n@1.0.0-beta.4
- @nifrajs/image@1.0.0-beta.4
- @nifrajs/web@1.0.0-beta.4

## 1.0.0-beta.3

### Patch Changes

- @nifrajs/i18n@1.0.0-beta.3
- @nifrajs/image@1.0.0-beta.3
- @nifrajs/web@1.0.0-beta.3

## 0.1.0-beta.2

### Patch Changes

- Updated dependencies [5018546]
  - @nifrajs/web@0.1.0-beta.2
  - @nifrajs/i18n@0.1.0-beta.2
  - @nifrajs/image@0.1.0-beta.2
