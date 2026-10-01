import type { UpgradeRecipe } from "./index.ts"

/**
 * Upgrade recipe for Nifra 3.6.
 *
 * No package is removed and no import specifier moves, so the runner only pins the fixed group. The
 * notes cover what an existing app may observe after upgrading.
 */
export const recipe: UpgradeRecipe = {
  version: "3.6.0",
  pins: [
    { match: "@nifrajs/", to: "3.6.0" },
    { match: "create-nifra", to: "3.6.0" },
    { match: "nifra", to: "3.6.0" },
  ],
  importMoves: [],
  notes: [
    '`withISR` no longer caches a page per query string by default: a request with any query parameter renders fresh and is not stored. Pass `query: ["page", ...]` to cache those parameters, or `query: "all"` to both `withISR` and `revalidateEndpoint` to keep the old keys.',
    "A page file under the backend's API prefix or any other mount (`routes/api/*.tsx` with a `backend.ts`) now fails at startup, at build and in `nifra check` (NF-C027), instead of answering 404. Move the page, change `apiPrefix` in framework.ts, or serve that path from the backend.",
    "Request methods match exactly: a request sent as `post` or `Patch` answers 405 or 404 instead of reaching the `POST`/`PATCH` route.",
    "A request path's `.` and `..` segments (also `%2e` and backslashes) are resolved before routing on every runtime, so `/users/../posts` routes to `/posts` and `c.req.url` shows the resolved path.",
    "A JSON body is parsed only when its media type is `application/json` or `application/*+json`; `text/plain; x=application/json` no longer parses, and server functions answer it with 415.",
    "`revalidateEndpoint()` and `previewEndpoint()` throw at construction without a `secret`.",
    'Rendering a hydrating page with an empty `clientEntry` throws instead of emitting `<script src="">`.',
    'The typed client refuses a `.` or `..` path param value (`{ ok: false, status: 0, error: { error: "invalid_path" } }`) instead of sending a request to another path.',
    "`jwt()`, `verifyCsrfToken()` and `verifyDownloadUrl()` accept only canonical unpadded base64url signatures.",
    "In plural messages, `#` is formatted in the locale's number format (`1,000 items`), not as plain digits.",
  ],
}
