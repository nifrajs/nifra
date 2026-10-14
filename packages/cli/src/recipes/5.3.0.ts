import type { UpgradeRecipe } from "./index.ts"

/**
 * Upgrade recipe for Nifra 5.3.
 *
 * No import or dependency moves. The typed client reads two route return shapes differently,
 * `nifra check` and `nifra upgrade` report more, and a build, a GraphQL endpoint, a session store and
 * a few constructors refuse inputs they used to take; each note says what changes and what keeps the
 * old answer.
 */
export const recipe: UpgradeRecipe = {
  version: "5.3.0",
  pins: [
    { match: "@nifrajs/", to: "5.3.0" },
    { match: "create-nifra", to: "5.3.0" },
    { match: "nifra", to: "5.3.0" },
  ],
  importMoves: [],
  notes: [
    "A route answering `status(code, body)` with a code typed as plain `number` types the client's `data` as that body, where it was `unknown`; a cast that recovered the type can go. A plain return beside `status(200, body)` types the 200 arm as either body, where the two were intersected, so client code that read a field only one of them has must narrow first.",
    "`nifra check` adds NF-C045 (warning): a route added to a server as a statement of its own (`app.get(...)` with its result unused) when that server is exported or read by `typeof`. The route is served, but the typed client never sees it. Chain the registration onto the server's declaration, or declare the routes on their own `server()` and `merge()` it; `// nifra-expect NF-C045: <reason>` above the statement keeps a route off the type on purpose.",
    "`nifra check` adds NF-C044 (warning): a `createWebApp` call that passes a `clientEntry` and no `copyChunks` in an app with copy tables (`@nifrajs/i18n/copy`), which fails in production on the first page that renders copy. Pass the `copyChunks` the generated server manifest exports; `// nifra-expect NF-C044: <reason>` on the call accepts a server that never serves those pages.",
    "`nifra check`'s raw-`Response` advisory (NF-C007) also reads routes chained onto `createWebApp(...)`, a `Response` held in a local before it is returned, a handler's `c.json()`/`c.text()`, and a call to a function imported from a relative module that returns one, reported at each route that returns it. Return plain data to keep the route typed, or mark an intended `Response` with `// nifra-expect NF-C007: <reason>`.",
    "`nifra upgrade` leaves a `peerDependencies` range alone when it already admits the target, and starts from the versions dependencies, devDependencies and overrides pin rather than from a peer floor, so a library workspace no longer replays older recipes. `nifra check` (NF-D002) and `nifra doctor` no longer count a peer floor as a second nifra version.",
    "A build no longer copies hidden files from `public/` - any path segment starting with `.` other than `.well-known` - so `.env`, `.git/` or `.DS_Store` there is no longer deployed or served, matching development. A host marker a static deploy relies on, such as GitHub Pages' `.nojekyll`, now has to be written into the build output after the build.",
    "`@nifrajs/graphql` refuses with a 400 before validation a document whose fragments, named and inline, expand past `maxFragmentExpansion` (default 20,000 selections summed over its selection sets), or whose fragment comparisons pass `maxFragmentComparisons` (default 100,000, which admits a binary tree of 255 fragments). Pass a higher limit to `respondGraphql`, `graphqlWebSocket` or `mountGraphql` if a legitimate client document is refused. A spread of an unknown fragment and a fragment cycle, which validation already refused, are refused before it too, with graphql-js's message and no `locations`.",
    "A store-mode `@nifrajs/auth` session now writes a revocation marker under `<id>.revoked` on logout and rotation, and every load reads it beside the record. A custom `SessionStore` must accept that key like any other; one that validates keys against the session-id shape has to allow the suffix. `destroy(c, session)` also empties the session object it is passed, in both modes, so read anything you need from it before the call; committing it afterwards starts a new session holding only what was set since.",
    "A raw request target holding a character a URL parser percent-encodes in a path (`\"`, `<`, `>`, `^`, `` ` ``, `{`, `}`, a space or non-ASCII) now routes as its encoded path on Node, Deno and Bun's native route table, as it already did on workerd and Bun's parsed URL: `GET /vault<tag>` reaches a route registered as `/vault%3Ctag%3E`, and `c.req.url` on Node and Deno carries the encoded form. Params are decoded as before.",
    "`rangeResponse()` and `servePublicDir` ignore `Range` on a HEAD request (RFC 9110 section 14.2): HEAD answers 200 with the full `content-length`, where it used to answer 206 or 416.",
    "Invalid numbers are refused where they used to disable a limit or strand work: `@nifrajs/edge` `server({ maxBodyBytes })` throws a `RangeError` for anything but a non-negative safe integer; `@nifrajs/jobs` `enqueue` throws for a `NaN` or infinite `delayMs` or `runAt`, `fixedBackoff`/`exponentialBackoff` throw for a non-finite or negative delay or a `jitter` outside [0, 1], and a backoff returning a non-finite delay dead-letters the job; `@nifrajs/mock` throws `UnsupportedMockSchemaError` for an `anyOf` whose every alternative contradicts the keywords beside it.",
    "`RenderAdapter.renderToString` may return `undefined` for a render that suspended; the page is then streamed. A custom adapter keeps working unchanged; code that calls an adapter's `renderToString` itself has to handle `undefined`. Under `createCspPolicy`, a buffered page whose render writes a script of its own (a Solid `ErrorBoundary` that caught a server error) now carries a nonce and `cache-control: private, no-store`, like a deferred page.",
    "A `@nifrajs/pi` turn whose provider refused Pi's sign-in or API key (an expired OAuth login, an incorrect key) now fails with code `PI_AUTH_REQUIRED` rather than `PI_MODEL_FAILED`, as `@nifrajs/acp` reports `ACP_AUTH_REQUIRED`. Code that matches `PI_MODEL_FAILED` to catch every failed model call has to match both.",
    "`FileStorage` resolves the directory holding its root once and checks it before every operation: renaming an ancestor of the root now fails each operation with `StorageKeyError`, and a root reached through a symbolic link that is later repointed keeps the first tree until restart. Restart the process after moving a storage root.",
  ],
}
