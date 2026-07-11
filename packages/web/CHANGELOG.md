# @nifrajs/web

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
