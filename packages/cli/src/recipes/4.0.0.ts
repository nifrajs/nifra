import type { UpgradeRecipe } from "./index.ts"

/**
 * Upgrade recipe for Nifra 4.0.
 *
 * The runner pins the fixed group and moves the retired `server-only` marker import. The layout move
 * is `nifra migrate layout`'s job, so the notes lead with it, then cover what an app may observe.
 */
export const recipe: UpgradeRecipe = {
  version: "4.0.0",
  pins: [
    { match: "@nifrajs/", to: "4.0.0" },
    { match: "create-nifra", to: "4.0.0" },
    { match: "nifra", to: "4.0.0" },
  ],
  importMoves: [{ from: "@nifrajs/web/server-only", to: "@nifrajs/web/backend-only" }],
  notes: [
    "Run `nifra migrate layout` (a dry run; `--write` applies it). An app's code now lives in `routes/`, `frontend/`, `backend/` and `shared/`: each route splits into `x.tsx` (the page) and `x.backend.ts` (`loader`, `action`, `middleware` and the other server exports), `_middleware.ts` folds into `_layout.backend.ts`, the root `backend.ts` and `framework.ts` move to `backend/app.ts` and `backend/framework.ts`, `*.server` modules move under `backend/`, and `ServerOnly` becomes `BackendOnly`. It lists what it could not decide.",
    "Browser builds and dev servers refuse backend code, server packages and any first-party file in no zone, naming the import chain; `nifra check` reports the same (NF-C004, NF-C028) and private environment reads in browser code (NF-C029).",
    "A loader or action that returns data needs `loaderOutput` / `actionOutput` in its backend half, or the request fails; the data is projected through the schema, so undeclared keys never reach the page. A deferred value is declared with `t.deferred(schema)`. `nifra check` reports a loader without one (NF-C030).",
    "Builds fail on what looks like a credential in a client bundle, a `public/` file or a prerendered page; exempt a reviewed false positive with `secretExemptions` in `nifra.config.ts`.",
    "The Cloudflare Pages target is `cloudflare` (`cf-pages` is refused), and `export const target` in `nifra.config.ts` sets what `nifra build` emits.",
    '`withISR` no longer caches a page per query string by default: a request with any query parameter renders fresh and is not stored. Pass `query: ["page", ...]` to cache those parameters, or `query: "all"` to both `withISR` and `revalidateEndpoint` to keep the old keys.',
    "A page file under the backend's API prefix or any other mount (`routes/api/*.tsx` with a backend) now fails at startup, at build and in `nifra check` (NF-C027), instead of answering 404. Move the page, change `apiPrefix` in `backend/framework.ts`, or serve that path from the backend.",
    "Request methods match exactly: a request sent as `post` or `Patch` answers 405 or 404 instead of reaching the `POST`/`PATCH` route.",
    "A request path's `.` and `..` segments (also `%2e` and backslashes) are resolved before routing on every runtime, so `/users/../posts` routes to `/posts` and `c.req.url` shows the resolved path.",
    "A JSON body is parsed only when its media type is `application/json` or `application/*+json`; `text/plain; x=application/json` no longer parses, and server functions answer it with 415.",
    "`revalidateEndpoint()` and `previewEndpoint()` throw at construction without a `secret`.",
    'Rendering a hydrating page with an empty `clientEntry` throws instead of emitting `<script src="">`.',
    'The typed client refuses a `.` or `..` path param value (`{ ok: false, status: 0, error: { error: "invalid_path" } }`) instead of sending a request to another path.',
    "`jwt()`, `verifyCsrfToken()` and `verifyDownloadUrl()` accept only canonical unpadded base64url signatures.",
    "In plural messages, `#` is formatted in the locale's number format (`1,000 items`), not as plain digits.",
    "`solidBunPlugin` is exported from `@nifrajs/web-solid/plugin` and `svelteBunPlugin` from `@nifrajs/web-svelte/plugin`; the adapter roots export only the render adapter. Run `nifra fix --code NF-C005` to rewrite the imports.",
  ],
}
