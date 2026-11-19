import type { UpgradeRecipe } from "./index.ts"

/**
 * Upgrade recipe for Nifra 5.15.
 *
 * This release has no import moves. A Solid app moves to Solid 2.0, which changes its dependencies and
 * its build plugin. The notes cover that move, copied job and shared-state payloads, serving an app on
 * `@nifrajs/node-uws` (which now seals it and answers fixed routes natively), the response body hook's
 * render fast path, `c.json()` on Bun and Deno under a body hook, and where `compression()` gzips on
 * Bun for Linux.
 */
export const recipe: UpgradeRecipe = {
  version: "5.15.0",
  pins: [
    { match: "@nifrajs/", to: "5.15.0" },
    { match: "create-nifra", to: "5.15.0" },
    { match: "nifra", to: "5.15.0" },
  ],
  importMoves: [],
  affects: [
    "@nifrajs/agent",
    "@nifrajs/core",
    "@nifrajs/jobs",
    "@nifrajs/middleware",
    "@nifrajs/node-uws",
    "@nifrajs/proxy",
    "@nifrajs/web-solid",
  ],
  notes: [
    '`@nifrajs/web-solid` targets Solid 2.0 and Solid 1.x is no longer supported. Depend on `solid-js` and `@solidjs/web` ^2.0.0, use `@solidjs/vite-plugin` ^3.0.1 under Vite (replacing `vite-plugin-solid`), set `jsxImportSource` to `@solidjs/web`, and drop the `"solid"` resolve condition from `conditions`. `babel-preset-solid`, `solid-refresh` and Babel are no longer dependencies of the adapter. Components using `createResource`, `Suspense`, `ErrorBoundary`, `onMount`, `Dynamic` or `Context.Provider` move to `createMemo` under `Loading`, `Errored`, `onSettled`, `dynamic()` and the context component; `splitProps` and `mergeProps` become `omit` and `merge`. `RouteSlotHooks` takes the Solid 2 `createEffect(compute, effect)` shape and no longer has `onCleanup`. In production a server render error reaches the client as a bare error with no server path.',
    "`MemoryJobStore` copies a job's payload when it is enqueued and again when it is leased, and refuses with a `TypeError` a payload a structured clone would change: a function, a class instance or null-prototype object, an accessor, an `Error`, or a `SharedArrayBuffer`. Pass such values as an identifier and rebuild them in the handler.",
    "Shared-state patch values and subscriber batches are copied, so each observer receives its own batch and a caller cannot change live state without a new patch. A value that cannot be cloned faithfully, including shared memory and custom prototypes, is rejected before the batch commits.",
    "`@nifrajs/proxy` requires a patched Undici as its peer: `^7.30.2 || >=8.12.4`. Update `undici` if your lockfile pins an older 7.x. `nifra check` now honors promoted diagnostic errors in its exit verdict, so a diagnostic you promoted to an error fails the run.",
    "`@nifrajs/node-uws` answers `staticResponse()` GET routes inside uWebSockets.js, without a call into JavaScript, and fixed POST routes without building a Web `Request`, whenever nothing in the app can observe the request (no request or response hook, deadline, capacity gate, Host policy, schema, auth or other route-level stage). A POST carrying an `Origin` header still goes through the cross-site form check. New `echoParam(path)` answers a GET route with its final path parameter as text, exactly as sent.",
    "Serving an app on `@nifrajs/node-uws` now seals it, as `listen()` does, so a hook or route added after `serve()` throws `SERVER_SEALED` instead of being skipped on the native paths. Register everything before serving.",
    "A response-observer bundle can offer `renderBody`, a synchronous fast path for its `onResponseBody` hook that builds one `Response` from a handler's returned value. The body hook is not run again over a response it rendered with new bytes, so a custom body hook that is also used as a renderer must be idempotent on its own output. `compression()` uses it; nothing changes for an app that does not write its own response-observer bundle.",
    "On Bun and Deno, `c.json()` keeps the JSON text it wrote when the app has a response body hook, as `c.text()` already did, so a gzipped `c.json()` reply goes out with a `Content-Length` instead of chunked. An app with no body hook builds its reply as before.",
    "`compression()` on Bun for Linux gzips a buffered body up to 64 KiB inline on the event loop, where bodies over 4 KiB went to the thread pool. Bun on macOS keeps the 4 KiB cut.",
  ],
}
