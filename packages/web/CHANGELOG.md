# @nifrajs/web

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
