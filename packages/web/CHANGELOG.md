# @nifrajs/web

## 2.0.0

### Major Changes

- d91a45b: Remove Nifra's remaining deprecated and compatibility-only public surfaces for the 2.0 cutover.

  - `@nifrajs/core` and `nifra` now expose only the lean HTTP server API at their package roots. Import
    optional systems from their documented subpaths. The deprecated invariant runner and the
    `@nifrajs/budget` compatibility package are removed; use `@nifrajs/testing` and
    `@nifrajs/core/budget` respectively.
  - Web redirects accept only an options object as their second argument, the prerender enumeration
    wrapper is removed in favor of `enumerateStaticRoutes()`, and fragment navigation resolves IDs only.
  - MCP Apps metadata uses only `_meta.ui.resourceUri`; the deprecated flat `ui/resourceUri` key is gone.
  - Telemetry uses `ObservationAdapter` directly; the `AgentSpan`, `AgentSpanExporter`, and `SpanExporter`
    aliases are removed.
  - Invalid HTTP method overrides always fail closed with 400; the legacy ignore mode is removed.
  - `nifra build` always emits a complete target deploy directory and defaults to Bun. The old
    client-only build branch is removed; `nifra start` runs the generated Bun `server.js`.

- d91a45b: The in-process backend mount is now exclusively the symbol-keyed `BackendMount` interface that `inProcessClient()` / `testClient()` implement.

  `createWebApp({ api })` auto-mounts a backend only through that symbol seam - the platform-aware path that forwards `env` / `waitUntil`. The `.fetch(url, init)` mount convention is gone: an `api` that only exposes a callable `.fetch` is no longer auto-mounted. Backends passed as `inProcessClient(app)` / `testClient(app)` are unaffected, since they carry the symbol mount already.

### Minor Changes

- e97a92f: `nifra sync-manifest`, plus two toolchain guards that turn opaque failures into actionable ones.

  - **`nifra sync-manifest`.** After adding/renaming/removing a page route, the committed `server-manifest.ts` drifts and `nifra check` flags it - and clearing that used to mean a full build (server + worker + migrate bundles). `nifra sync-manifest` re-scans `routes/` and rewrites just the manifest's route table in milliseconds, preserving the baked client-asset references. It does not rebuild the client bundle, so it prints a caveat: a brand-new hydrating route component still needs a full build for its client chunk. `@nifrajs/web/build` gains the pure `resyncServerManifestSource` (+ `parseManifestStyles` / `parseManifestRouteStyles`) it is built on.
  - **`nifra dev` peer preflight.** Run under `bunx @nifrajs/cli dev` (an isolated install where the project's peers do not resolve), the Vite import failed with an opaque `ERR_MODULE_NOT_FOUND`. It now checks `vite` resolves from the project first and, if not, says to run the workspace-local `bun run dev`.
  - **`nifra start` build-target guard.** Pointed at a Cloudflare Pages output (a `_worker.js` bundle, no `server.js`), `nifra start` now names the mismatch and the fix (`nifra build --target bun`, or serve with `wrangler pages`) instead of a bare "no server.js".

- e8e49d1: Two new build plugins for the `Bun.build` production step, both opt-in and dependency-free until used.

  - **`postcssBunPlugin` (`@nifrajs/web/plugins/postcss`)** - runs `*.css` / `*.pcss` / `*.postcss` through PostCSS, feeding the result into the existing stylesheet pipeline (and the CSS-modules scoped-class transform for `*.module.*`). This is the Tailwind v4 path: a `postcss.config.js` with `@tailwindcss/postcss` compiles `app.css` importing `tailwindcss` at build time with no framework-specific code. `postcss` (and `postcss-load-config`, when you don't pass `plugins` explicitly) are optional peers, loaded lazily and failing loud with an install hint. Mirrors the SCSS plugin: pass `"dom"` for the client bundle, preload `"ssr"` for the server.

  - **`svgComponentBunPlugin` (`@nifrajs/web/plugins/svg`)** - import an SVG as a component, `import Icon from "./icon.svg?component"`, then `<Icon className="w-6 h-6" />` with props spread onto the root `<svg>` (the Vite `svgr` workflow). Emits an automatic-JSX-runtime component, so it works for React and Preact today; Solid/Svelte/Vue are out of this version. Optional `svgo` optimization. A plain `import "./icon.svg"` asset URL is untouched - only the `?component` marker is intercepted.

- a7d34e5: Navigation loading UI for `@nifrajs/web-react/router`, plus a per-link pending signal.

  nifra navigates imperatively - it fetches the next route's chunk and loader data while the current route stays on screen, then swaps - so a route transition is signalled by the router's `pending` flag, not a Suspense boundary.

  - `useNavigation()` returns `{ pending, state: "idle" | "loading", location }` (Remix-shaped); `location` is the `pathname + search` being navigated to while pending. `usePending()` is the boolean form.
  - `NavLink`'s render-prop `isPending` is now real: it is `true` while a navigation to that link's own target is in flight (matched like `isActive`), so a link can show its own spinner. Previously always `false`.
  - The agnostic router now publishes `pendingPath` (the navigation target) on its state while `pending`, and `compose` threads `pending`/`pendingPath` into the router context. Both are `false`/absent on the server and the initial client render, so they are hydration-safe.

### Patch Changes

- ade0c7a: Add a curated `@nifrajs/core/server` entry for the common HTTP runtime and dedicated subpaths for
  contracts, classification, cookies, logging, routing, Standard Schema, SEO, SSE, and webhooks. The
  package root remains backwards compatible, while new scaffolds and first-party runtime packages avoid
  eagerly parsing opt-in causality, invariant, manifest, reflection, capability, and assurance tooling.
- Updated dependencies [a7b1d60]
- Updated dependencies [eaac3d7]
- Updated dependencies [ade0c7a]
- Updated dependencies [82676e0]
- Updated dependencies [1522d06]
- Updated dependencies [a7b1d60]
- Updated dependencies [a7b1d60]
  - @nifrajs/core@2.0.0

## 1.13.0

### Minor Changes

- 5b6127a: Make route batches atomic, seal server configuration after `listen()`, encode array query values as
  repeated keys, and align web route matching with the server.

  Three behavior changes to know about:

  - **Configuring a server after `listen()` now throws** instead of reaching some traffic and not the
    rest. Bun's native route table is compiled when you listen, so a hook added afterwards applied to
    `app.fetch()` but not to real HTTP requests: an `onRequest` guard installed late was silently
    skipped on the wire. Register routes, hooks, plugins, and context before listening.
  - **Array query values serialize as repeated keys** (`?tag=a&tag=b`), not `?tag=a%2Cb`, so a route
    whose `query` schema declares an array now receives one.
  - **The web matcher applies the server's trailing-slash rule.** `/users/7/` no longer matches
    `/users/:id` in the browser, matching the 404 the server already returns, and a malformed percent
    encoding reports no route instead of throwing.

  A route batch from `implement()` or `merge()` commits only once every route in it validates, so a
  collision partway through leaves matching and reflection untouched instead of stranding the routes
  registered before it.

  Each route now owns one immutable compiled execution plan shared by portable, Node-direct, and
  Bun-native dispatch. This also fixes validation recovery being skipped when a derive moved a route
  from a specialized lane to the generic lifecycle.

  Core, browser navigation, Bun-native parameter metadata, and mock routing now consume the same
  compiled pattern kernel. Static routes beat parameters and parameters beat wildcards regardless of
  manifest order, with one grammar, trailing-slash policy, and malformed-encoding rule.

### Patch Changes

- Updated dependencies [aae8614]
- Updated dependencies [5b6127a]
  - @nifrajs/core@1.13.0

## 1.12.0

### Patch Changes

- Updated dependencies [63d3845]
- Updated dependencies [246f498]
  - @nifrajs/core@1.12.0

## 1.11.0

### Minor Changes

- 5638ada: Add an explicit symbol-keyed in-process backend mount interface. `inProcessClient` implements the
  interface and `createWebApp` forwards the outer request's platform context through it, so an
  auto-mounted backend receives the same Workers `env` bindings and `waitUntil` lifetime as the web app.

  The released `.fetch(url, init)` duck-typed mount remains as a compatibility fallback for custom
  bridges. `Server.onRequest` now receives the optional platform object as its second argument.

### Patch Changes

- Updated dependencies [2dde7e5]
- Updated dependencies [279f80c]
- Updated dependencies [5638ada]
- Updated dependencies [279f80c]
  - @nifrajs/core@1.11.0

## 1.10.0

### Patch Changes

- Updated dependencies [92181be]
- Updated dependencies [3773f0a]
- Updated dependencies [92181be]
  - @nifrajs/core@1.10.0

## 1.9.1

### Patch Changes

- 3eb27ae: Internal tidy — remove a dead local variable in the query engine and clean up example wording in doc comments. No API or behavior change.
  - @nifrajs/core@1.9.1

## 1.9.0

### Minor Changes

- 0e1b4cc: Add a full React Query core on `@nifrajs/web-react/query` — `useQuery` (now with `enabled`/`staleTime`),
  `useMutation`, `useInfiniteQuery`, `useQueryClient`, `QueryClientProvider`, and the SSR
  `HydrationBoundary` — a drop-in for the TanStack Query surface, backed by an expanded agnostic engine in
  `@nifrajs/web`.

  The engine (`createQueryClient`) gains imperative cache ops (`getQueryData`/`setQueryData` for optimistic
  updates, `prefetchQuery`), per-query `staleTime`, SSR `dehydrate`/`hydrate`, and paged (`infiniteQuery`)
  support; plus a standalone `createMutation` state machine (single-flight, TanStack callback order). All
  logic lives in the injected-clock, framework-free engine so it's deterministically tested; the React
  bindings are thin `useSyncExternalStore` wrappers. A hook without a `QueryClientProvider` uses a
  client-side singleton (SSR-idle); with a `HydrationBoundary`-fed provider client, queries render their
  server-seeded data during SSR with no hydration flash.

- 6b67833: Add first-class React routing bindings on the new `@nifrajs/web-react/router` subpath — `<Link>`,
  `<NavLink>`, `useNavigate`, `useParams`, `useLocation`, `useSearchParams`, and `<Navigate>` — a
  drop-in replacement for `react-router-dom`'s routing surface over nifra's own file-based router.

  The read hooks are SSR-correct: `@nifrajs/web` now threads the matched route's `params` and the
  request `path` (`pathname + search`) through the render seam (`RenderProps`), and the React adapter's
  `compose` provides them via a `RouterContext` on both the server render and the client mount — so
  `useParams`/`useLocation`/`useSearchParams` return the same value on each side with no hydration
  mismatch. Programmatic navigation flows through a new DOM-free bridge (`getBrowserNavigate` /
  `setBrowserNavigate`, populated by `installHistory`), which also gains history `replace` support, so a
  route component reaches history-aware navigation without importing the browser-only client layer.

### Patch Changes

- Updated dependencies [03cd76f]
- Updated dependencies [03cd76f]
  - @nifrajs/core@1.9.0

## 1.8.0

### Patch Changes

- 1ffd48b: fix(web): the static/client build no longer ships the generated `_nifra-entry.ts` source. `buildClient`
  wrote the client-entry source into the output dir purely as a `Bun.build` entrypoint but never removed it
  after bundling — so `nifra build --target static` leaked the TypeScript source next to the content-hashed
  `_nifra-entry-<hash>.js` the HTML actually references. It's now deleted once the client bundle succeeds; a
  static-build test asserts the `.ts` is absent from the output.
- Updated dependencies [e47c4c5]
  - @nifrajs/core@1.8.0

## 1.7.0

### Minor Changes

- 9f23e90: Fix `nifra build --target static` producing pages that render but never hydrate. The prerender pass hardcoded a placeholder client entry, but the real bundle is content-hashed — so the prerendered HTML's hydration `<script src>` 404'd and every control was inert. `BuildTargetOptions.prerenderApp` is now a factory `(client: BuildManifest) => app` invoked with the completed client build, so the emitted `<script src>` uses the real hashed entry (plus the same styles / route-preload the SSR targets use). A regression test asserts the static HTML references the emitted hashed entry and that the file exists under `/assets`. Breaking only for code calling `buildTarget("static", …)` directly (pass a factory instead of a prebuilt app); `nifra build --target static` users just get working hydration.

### Patch Changes

- Updated dependencies [bd95181]
  - @nifrajs/core@1.7.0

## 1.6.0

### Patch Changes

- @nifrajs/core@1.6.0

## 1.5.0

### Patch Changes

- Updated dependencies [1ac2fde]
- Updated dependencies [bd3433f]
- Updated dependencies [70aa836]
  - @nifrajs/core@1.5.0

## 1.4.0

### Minor Changes

- 4d25970: Add one fail-open request-observation lifecycle shared by tracing, agent telemetry, and DevTools; secured development tooling; contract-based mock responses; validator-neutral schema/route reflection; executable render and storage adapter conformance modules; optional storage pagination/signing/copy capabilities; and metadata-preserving local file storage.

### Patch Changes

- Updated dependencies [4d25970]
  - @nifrajs/core@1.4.0

## 1.3.1

### Patch Changes

- @nifrajs/core@1.3.1

## 1.3.0

### Minor Changes

- 4a4b1c4: feat: `errors` response contract on routes + typed client error bodies

  A route's `RouteSchema` may now declare `errors` — a `{ status → Standard Schema }` map of its failure modes.
  Like `response`, it's a compile-time + introspection contract (not validated at runtime, zero hot-path cost):
  the declared error bodies flow into OpenAPI as non-2xx `responses` and into the `/llms.txt` context, so
  tooling and coding agents can read the _whole_ contract, not just the happy path.

  The **typed client** now surfaces them: on a failure `Result`, `data` is the parsed error body typed from the
  route's `errors` (a union across declared statuses; `unknown` when none declared), discriminated by `ok`.
  `error` remains the normalized `{ error, issues }` summary. The **decoupled contract client**
  (`client(contract, url)`) gets the same treatment — its failure `data` is typed from the op's non-2xx
  `responses` schemas.

  **Behavior change:** on failure, `data` is now the parsed error response body (previously always `null`) — so
  `const { ok, data } = await api.orders.post(...)` gives you the typed error body in the `!ok` branch. `data`
  is still `null` only on a transport error (status `0`, no response).

### Patch Changes

- Updated dependencies [4a4b1c4]
- Updated dependencies [4a4b1c4]
- Updated dependencies [4a4b1c4]
- Updated dependencies [4a4b1c4]
- Updated dependencies [4a4b1c4]
  - @nifrajs/core@1.3.0

## 1.2.2

### Patch Changes

- @nifrajs/core@1.2.2

## 1.2.1

### Patch Changes

- c3ebd73: fix(web): silence the spurious `jsx` "Invalid key" warning at `nifra dev` boot under rolldown-vite

  `@vitejs/plugin-react`'s `react()` returns an ARRAY of plugins, and `nifra.config.ts` lists it as
  `vitePlugins = [react()]`, so the plugin list reaches nifra NESTED (`[[babel, refresh]]`).
  `normalizeRolldownPlugins` — which strips the stale `optimizeDeps.rollupOptions.jsx` key that Vite 8's
  rolldown dep-optimizer rejects — mapped over the outer array without flattening, so it never reached the
  inner `vite:react-babel` plugin that emits the key, and Vite (which flattens plugin arrays itself) then ran
  the un-stripped hook. It now flattens first, so the strip reaches every plugin and the harmless-but-noisy
  `Warning: Invalid input options … "jsx" Invalid key: Expected never but received "jsx"` is gone. No
  behavior change — JSX transform, HMR, and Fast Refresh are unaffected.

  - @nifrajs/core@1.2.1

## 1.2.0

### Patch Changes

- Updated dependencies [0ac2182]
  - @nifrajs/core@1.2.0

## 1.1.0

### Minor Changes

- 37d2383: feat(web): `@nifrajs/web/forms` — typed form ↔ backend-schema binding

  `formFor<typeof backend, "/route">()` binds a form's field names and reads to the route's body schema at
  the type level, derived purely from `typeof backend`. `f.field("text")` (spread onto any framework's
  `<input>`) and `f.read(formData, "text")` are constrained to the body's keys — a typo, an orphan field,
  or a wrong route path becomes a COMPILE error (caught by `nifra check`) instead of a silent runtime
  empty. Framework-agnostic, dependency-free, no schema bundled into the client (the runtime is a trivial
  pass-through; all the work is in the types). It checks the field KEY, not its MEANING.

### Patch Changes

- @nifrajs/core@1.1.0

## 1.0.0

### Patch Changes

- f1f0e18: Context ergonomics, from beta feedback building on Nifra.

  - **`c.json(body, status?)` / `c.text(body, status?)`** — build a `Response` in one line; the second arg is a status number or a full `ResponseInit`, and it works whether you `return` or `throw` it. Ideal for an auth / rate-limit short-circuit from a `derive`/`beforeHandle`: `throw c.json({ error: "unauthorized" }, 401)` instead of `new Response(JSON.stringify(…), { status: 401, headers: … })`. (In a route's happy path keep returning a plain object so the typed client stays in sync.) Added as prototype methods — no per-request allocation.
  - **One name for the request across routes and loaders.** A route handler's `c.req` is now also `c.request`, and a page loader/action's `ctx.request` is now also `ctx.req` — fixing the `c.req`-vs-`ctx.request` mismatch that was easy to trip over.

  Docs: the API page documents `c.json`/`c.text` + the request alias; a new troubleshooting entry covers a `never` typed client (raw-`Response` return, or a non-identity plugin → `defineIdentityPlugin`).

- Updated dependencies [f1f0e18]
- Updated dependencies [3efb7cd]
- Updated dependencies [de9675b]
  - @nifrajs/core@1.0.0

## 1.0.0-beta.4

### Patch Changes

- @nifrajs/core@1.0.0-beta.4

## 1.0.0-beta.3

### Patch Changes

- @nifrajs/core@1.0.0-beta.3

## 0.1.0-beta.2

### Patch Changes

- 5018546: fix(web): built apps now ship their CSS link. `buildServer`/`generateServerManifest` bake the client build's
  stylesheet URLs (`BuildManifest.css` + `routeStyles`) into the server manifest, and the generated server entry
  passes them to `createWebApp` — which already emits `<link rel="stylesheet">` in the SSR `<head>`. Previously the
  head carried the JS modulepreload but no stylesheet, so every built (non-dev) app rendered unstyled. `styles`
  and `routeStyles` are now always exported from the generated manifest (default empty), so hand-written server
  entries can `import { styles, routeStyles } from "./server-manifest"` and forward them too.
  - @nifrajs/core@0.1.0-beta.2
