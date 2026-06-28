# @nifrajs/web

## 1.0.0-beta.5

### Patch Changes

- f1f0e18: Context ergonomics, from beta feedback building on Nifra.

  - **`c.json(body, status?)` / `c.text(body, status?)`** — build a `Response` in one line; the second arg is a status number or a full `ResponseInit`, and it works whether you `return` or `throw` it. Ideal for an auth / rate-limit short-circuit from a `derive`/`beforeHandle`: `throw c.json({ error: "unauthorized" }, 401)` instead of `new Response(JSON.stringify(…), { status: 401, headers: … })`. (In a route's happy path keep returning a plain object so the typed client stays in sync.) Added as prototype methods — no per-request allocation.
  - **One name for the request across routes and loaders.** A route handler's `c.req` is now also `c.request`, and a page loader/action's `ctx.request` is now also `ctx.req` — fixing the `c.req`-vs-`ctx.request` mismatch that was easy to trip over.

  Docs: the API page documents `c.json`/`c.text` + the request alias; a new troubleshooting entry covers a `never` typed client (raw-`Response` return, or a non-identity plugin → `defineIdentityPlugin`).

- Updated dependencies [f1f0e18]
- Updated dependencies [3efb7cd]
  - @nifrajs/core@1.0.0-beta.5

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
