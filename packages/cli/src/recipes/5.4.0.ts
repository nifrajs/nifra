import type { UpgradeRecipe } from "./index.ts"

/**
 * Upgrade recipe for Nifra 5.4.
 *
 * No import or dependency moves. A `node` build needs the adapter of the same release, and static
 * files answer validators, ranges and types the same way on every runtime; each note says what an
 * app or a client sees differently.
 */
export const recipe: UpgradeRecipe = {
  version: "5.4.0",
  pins: [
    { match: "@nifrajs/", to: "5.4.0" },
    { match: "create-nifra", to: "5.4.0" },
    { match: "nifra", to: "5.4.0" },
  ],
  importMoves: [],
  // `@nifrajs/core` gained `static-file`, which only these load; `nifra dev` serves files with web's reader.
  affects: ["@nifrajs/cli", "@nifrajs/node", "@nifrajs/web"],
  notes: [
    "The server entry a `node` build generates passes the app itself to `@nifrajs/node`'s `serve` and serves files with the adapter's own reader, so it needs the `@nifrajs/node` of the same release. With an older adapter installed the build stops before bundling, names both versions and leaves the last deploy dir in place, where a 5.3 adapter used to build and then throw when the server started. Upgrade `@nifrajs/node` with the rest.",
    "Static files carry a strong `ETag` from their content (128 bits of SHA-256) on the Bun entry and `nifra dev` (`servePublicDir`), `@nifrajs/node`'s `static` reader and the generated Deno entry, the same for the same bytes on every instance. The Node reader's `\"<mtime>-<size>\"` tag is gone, so clients and caches revalidate each file once after the upgrade. `Last-Modified` is sent only while a file's mtime is its own last change, so a file whose mtime a copy or build set (every file in a container image) is sent without one and `If-Modified-Since` cannot validate it. An `If-Range` date no longer keeps a range for a tagged file; a client resumes by the tag.",
    "The generated Deno entry answers static files with `etag` and `last-modified`, a `304` with no body for a current copy (HEAD included), and honors `Range` only when `If-Range` is absent or names the file's current validator, as the Bun and Node entries do. On Bun and Deno `If-None-Match` is evaluated before `If-Modified-Since`, so a stale entity tag no longer gets a `304` from the date beside it.",
    "`@nifrajs/node`'s `serve({ static })` types files from the same table as `servePublicDir`, so `.pdf`, `.mp4`, `.xml`, `.csv` and other common types are no longer sent as `application/octet-stream`. It serves `/.well-known` by default, refuses a visible name that links to a dotfile, and answers a link that leaves the directory with `404` where it answered `403`. `static` also takes an array of mounts, a `files` list a mount is limited to, and `cacheControl`.",
    "`@nifrajs/node`'s `static` reader parses `Range` with `@nifrajs/core/range`, like the other runtimes: overlapping or adjacent ranges are served as the one range they cover, a satisfiable range listed with unsatisfiable ones is served, an inverted range (`bytes=9-0`) answers `416` where it was ignored, a zero-length suffix (`bytes=-0`) sends the whole file where it answered `416`, and a `Range` longer than 16 KiB is ignored.",
    "On Bun, `servePublicDir` (the Bun entry and `nifra dev`) sends `content-length` for files up to 1 MiB, whole or ranged, where Bun used to send them chunked with no length. Files above 1 MiB are still sent chunked.",
  ],
}
