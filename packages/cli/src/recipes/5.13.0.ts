import type { UpgradeRecipe } from "./index.ts"

/**
 * Upgrade recipe for Nifra 5.13.
 *
 * This release has no import or dependency moves. Its notes cover the stricter cross-site form
 * policy, the native-shell transport, and the handle and idempotency changes.
 */
export const recipe: UpgradeRecipe = {
  version: "5.13.0",
  pins: [
    { match: "@nifrajs/", to: "5.13.0" },
    { match: "create-nifra", to: "5.13.0" },
    { match: "nifra", to: "5.13.0" },
  ],
  importMoves: [],
  affects: [
    "@nifrajs/cli",
    "@nifrajs/client",
    "@nifrajs/core",
    "@nifrajs/cron",
    "@nifrajs/deno",
    "@nifrajs/edge",
    "@nifrajs/image",
    "@nifrajs/jobs",
    "@nifrajs/middleware",
    "@nifrajs/node",
    "@nifrajs/web",
    "create-nifra",
  ],
  notes: [
    "A route without a body schema now refuses a cross-site HTML form post, and an unsafe request with no content type from an untrusted site, with `403 forbidden_origin` before the handler runs, on every lane including Bun's native route table and `@nifrajs/edge`. An app that handles CORS outside Nifra, such as a reverse proxy adding the headers, and takes bodyless cross-origin `POST`, `PUT`, `PATCH` or `DELETE` calls without an `Authorization` header needs that frontend's origin in `formOrigins`.",
    "The origins a `cors()` list or predicate and a `csrf({ origins })` list name are now trusted for form posts, so those frontends need no second copy in `formOrigins`. Audit those origins: a named origin may now also post a form to the routes of the server that installs the middleware.",
    "A route's `allowedOrigins` function receives, as its second argument, whether the default same-origin check would admit the request.",
    "`createClientRouter` takes a `fetch` option and a build takes a `transport` module, so a page inside a native shell can reach its server on another origin. `nifra shell tauri` and `create-nifra --shell tauri` scaffold a Tauri 2 shell; `nifra build --target static --prerender <paths>` prerenders the pages a shell build opens on.",
    "Standalone idempotency response serialization and replay, and in-process client response decoding, are bounded to 1 MB by default. Set `maxBytes` or a route's `maxResponseBytes` to change the limit.",
    "Bun `listen()` handles, Node and Deno `serve()` handles, jobs workers, cron schedulers, client subscriptions and client WebSockets can be held with `await using` or `using`.",
    "Native query URL parsing and remote image body handling are stricter, and the web query cache does less repeated hashing, invalidation and eviction work.",
    "The generated client entry sets `data-nifra-hydrated` on a timer while the view is hidden, so a window created hidden no longer waits for an animation frame.",
  ],
}
