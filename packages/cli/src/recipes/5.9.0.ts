import type { UpgradeRecipe } from "./index.ts"

/**
 * Upgrade recipe for Nifra 5.9.
 *
 * One `serveStatic` with one set of options on every runtime: `@nifrajs/web`'s `servePublicDir` is
 * removed, and `@nifrajs/node`'s `static` takes a function. The `serve-static` source rewrite moves
 * each call, and `gracefulSignals` replaces `signals` on the Node and Deno adapters.
 */
export const recipe: UpgradeRecipe = {
  version: "5.9.0",
  pins: [
    { match: "@nifrajs/", to: "5.9.0" },
    { match: "create-nifra", to: "5.9.0" },
    { match: "nifra", to: "5.9.0" },
  ],
  importMoves: [],
  sourceRewrites: ["serve-static"],
  // A servePublicDir call on Bun becomes @nifrajs/core/serve-static's, which an app may have had only
  // through @nifrajs/web.
  dependencyAdds: [
    { imports: ["@nifrajs/core/serve-static"], add: "@nifrajs/core", beside: ["@nifrajs/web"] },
  ],
  affects: [
    "@nifrajs/core",
    "@nifrajs/schema",
    "@nifrajs/mcp-db",
    "@nifrajs/web",
    "@nifrajs/node",
    "@nifrajs/deno",
  ],
  notes: [
    '`servePublicDir` is removed from @nifrajs/web. Each call becomes `serveStatic({ dir, prefix: "/", fallthrough: true, hashedFiles, cacheControl: ONE_DAY })`, from @nifrajs/core/serve-static on Bun, and from @nifrajs/node or @nifrajs/deno in a file that serves on one of them: the same files, headers and misses as before. A `cache.hashed` other than the one-year immutable policy, or options built elsewhere, is listed to edit by hand. `serveStatic` answers `undefined` synchronously for a path no mount takes, so `handler(request).then(...)` needs `await` or `?.then`.',
    "@nifrajs/node's `static` takes a function, as on Bun and Deno: mount objects passed to it are wrapped in `serveStatic(...)`, which keeps them on Node's own request. A mount object `static` names through a variable is listed; passing one throws a TypeError that names `serveStatic`.",
    "`serve()` on @nifrajs/node and @nifrajs/deno takes `gracefulSignals` in place of `signals`, the name Bun's `server()` uses; `signals` throws a TypeError.",
    "@nifrajs/deno exports `serveStatic`, which reads files with Deno's file API. The servers `nifra build` emits for bun, node and deno pass their runtime's `serveStatic` the same mounts, so a missing file under /assets/ or a listed public file answers `404 Not Found` on each.",
    "Host validation is opt-in on Deno, as it is on Bun. Deno used to answer `400 invalid_host` for a malformed Host by default; it now routes the Host it received unless `server({ validateHost: true })` is set. Deno builds `Request.url` from the Host, so set it when Deno receives requests with an untrusted Host header.",
    "Request targets are no longer normalized by default on Deno and Node. `/public/../admin` used to be routed as `/admin` on every runtime; Deno and Node now route the target as sent, as most frameworks do, and Bun still delivers a parsed URL. Set `server({ normalizeTarget: true })` on Deno or `serve(app, { normalizeTarget: true })` from @nifrajs/node when path guards, or a proxy that normalizes paths, sit in front of or inside the app.",
    "The `date-time`, `date` and `time` string formats in @nifrajs/schema follow RFC 3339 in full: a day the calendar lacks (`2026-02-30`), an hour of `24` and an offset past `23:59` now fail validation. `t.date()` is a `Date` in code and an RFC 3339 string on the wire, in a request and a response alike.",
    "@nifrajs/mcp-db/postgres checks the connected role's own privileges before every query and explain, and refuses a role that can read a masked column, an excluded table, a view over hidden data or a SECURITY DEFINER function with `NIFRA_DB_ROLE_GRANTS`. Run `nifra db role` for the grants a declaration needs, or name a function in `devDatabase.allowFunctions`.",
  ],
}
