import type { UpgradeRecipe } from "./index.ts"

const ADAPTERS = [
  "@nifrajs/web-react",
  "@nifrajs/web-vue",
  "@nifrajs/web-svelte",
  "@nifrajs/web-solid",
  "@nifrajs/web-preact",
]

/**
 * Upgrade recipe for Nifra 5.7.
 *
 * The React Auth.js bindings move from `@nifrajs/web-react/auth` to `@nifrajs/authjs/react`, so the
 * React adapter no longer names Auth.js at all. The import moves mechanically. The UI adapters take
 * `@nifrajs/image` and `@nifrajs/i18n` as optional peers, and web-react drops `@nifrajs/schema`, so
 * each package an app reached only through an adapter is added beside it where a file imports it.
 * The notes name every other change an app can observe, and `affects` lists the packages they touch.
 */
export const recipe: UpgradeRecipe = {
  version: "5.7.0",
  pins: [
    { match: "@nifrajs/", to: "5.7.0" },
    { match: "create-nifra", to: "5.7.0" },
    { match: "nifra", to: "5.7.0" },
  ],
  importMoves: [{ from: "@nifrajs/web-react/auth", to: "@nifrajs/authjs/react" }],
  dependencyAdds: [
    { imports: ["@nifrajs/authjs"], add: "@nifrajs/authjs", beside: ["@nifrajs/web-react"] },
    { imports: ADAPTERS.map((adapter) => `${adapter}/image`), add: "@nifrajs/image" },
    { imports: ADAPTERS.map((adapter) => `${adapter}/i18n`), add: "@nifrajs/i18n" },
    { imports: ["@nifrajs/schema"], add: "@nifrajs/schema", beside: ["@nifrajs/web-react"] },
  ],
  notes: [
    "`<AuthSessionProvider>` and `useAuthSession()` are imported from `@nifrajs/authjs/react`; `@nifrajs/web-react/auth` is removed. `@nifrajs/web-react` no longer brings `@nifrajs/authjs` in, so `nifra upgrade` adds it beside `@nifrajs/web-react` in each package.json above a file that imports it without listing it. `@nifrajs/authjs` takes `react` as an optional peer. The useAuthSession error outside a provider reads `[nifra/authjs]`, where it read `[nifra/web-react]`.",
    "`@nifrajs/image` and `@nifrajs/i18n` are optional peers of `@nifrajs/web-react`, `web-vue`, `web-svelte`, `web-solid` and `web-preact`, where they were dependencies, so an adapter's `/image` or `/i18n` entry fails to resolve unless the app lists the package. `nifra upgrade` adds it beside the adapter in each package.json above a file that imports the entry; an app that already lists it needs no change.",
    "`@nifrajs/web-react` no longer depends on `@nifrajs/schema`, so `nifra upgrade` adds `@nifrajs/schema` beside `@nifrajs/web-react` in each package.json above a file that imports it without listing it.",
    '`healthcheck()`\'s `/ready` body changes shape: each check is `{ status: "pass" | "fail" | "timeout", ms }` (plus `optional: true`) where it was a boolean, and the top-level `status` can also be `degraded` or `stopping`, so a monitor that reads the body rather than the status code needs updating. `/ready` answers `503` from the moment a stop begins, a check slower than `timeoutMs` (default 2 s) fails as `timeout`, and a finished run answers probes for `cacheMs` (default 1 s).',
    'A `bigint` in a JSON answer is written as its decimal string on every runtime, where the route answered a 500, and the typed client reads such a field as `string`. A typed array in an answer is typed on the client as the index object it is sent as (string entries for a `BigInt64Array`), and a Node `Buffer` as `{ type: "Buffer", data: number[] }`; declare the field `t.bytes()` to send base64 instead.',
    "A document from `toOpenAPI`, `buildOpenApiDocument` or `openapi()` lists `500` on every operation, `404` where a path parameter has a pattern, and `429` with `Retry-After` on a `rateLimit()` route, as the shared `NifraError` component, so a client generated from it gains those responses. An array query parameter is declared `style: form, explode: true`.",
    "A `t.object` in a `query`, `headers` or `cookies` slot converts the text it receives to the types it declares (`?archived=true` is `true`, `?page=2` is `2`), where such a request was a 422; a `body` slot still converts nothing.",
    '`nifra check` adds NF-C054 (info), a route with no `response` schema in a project that builds its document from the running routes, and NF-C055 (warn), zod\'s `z.coerce.boolean()` in a `query`, `headers` or `cookies` schema, which reads `"false"` as `true` (use `z.stringbool()`). It also reports a single-copy declaration as not enforced when `bunfig.toml` preloads the registrar for only one of `bun run` and `bun test`, or writes the `preload` line under another table such as `[install]`.',
    "`logger()` logs the matched route template as `path` (`/share/:token`) instead of the request path and never logs the query string; `rawPath: true` logs the pathname. A request no route matched logs its pathname.",
    "A `rateLimit()` or `rateLimitTiers()` `key` that throws or rejects is charged to the client IP instead of failing the request.",
    "A `mount()` authentication refusal is final even when its status is 404 and child-miss fallthrough is on, for HTTP and WebSockets, so a later route no longer answers a request the mount's gate refused.",
    "The typed client sends its configured response codec's `Accept` on GET, bodyless and multipart requests too, not only on JSON ones; an explicit `Accept` header still wins.",
    "Validation issue paths decode JSON Pointer escapes, so a field named `a/b` is reported as `a/b` rather than `a~1b`, by the runtime and the precompiled validators alike.",
    "A server-rendered page no longer runs its loaders a second time when its live socket opens (partial prerendering, server-component routes and Workers hub mode keep the full first load), and a page polling while its socket is down reloads all its data on each poll. `live.close()` ends every socket with `1001`; call it in `onStop` before closing the Redis clients.",
    "Kept pages are dropped on a sign-in or sign-out through a Better Auth session cookie under any `advanced.cookiePrefix` and on an explicit bearer-auth identity change, cross-tab signals included, and a page Back restores is kept again only under the visitor it was restored for.",
    "A client navigation requests its data before the view transition starts, and the swap waits at most 100 ms for a frame before skipping the animation. A navigation that a newer one supersedes settles quietly instead of rejecting and loading the older page as a document.",
    "A `Date` in a streamed partial-prerendering interactive prop or a signed shared-cache entry arrives as a `Date` across processes, and a cache entry with an invalid Date tag is a miss. A production server bundle reads `NODE_ENV` at build time in partial prerendering, the Vue adapter's streamed render and the Solid adapter's error serialization.",
    "`nifra dev`, `build`, `start` and `check` started from a global or linked CLI run through the project's own `@nifrajs/cli`, at any version (`NIFRA_LOCAL_CLI=0` runs the CLI as invoked), and `nifra mcp` hands a session over on the same rule.",
    "`nifra upgrade --write` leaves bun.lock as it is and lists its stale `file:` entries with the `bun update` that refreshes them, so the `--json` plan no longer carries `lockPruned`. It skips gitignored files.",
    "`nifra contracts snapshot` records each route part with its own digest, so after the next snapshot `nifra contracts check` and the `nifra check` contract gate also catch a change to a headers or cookies schema. A lock written before then compares as before.",
  ],
  affects: [
    "@nifrajs/authjs",
    "@nifrajs/cli",
    "@nifrajs/client",
    "@nifrajs/core",
    "@nifrajs/edge",
    "@nifrajs/middleware",
    "@nifrajs/node",
    "@nifrajs/schema",
    "@nifrajs/web",
    "@nifrajs/web-preact",
    "@nifrajs/web-react",
    "@nifrajs/web-solid",
    "@nifrajs/web-svelte",
    "@nifrajs/web-vue",
  ],
}
