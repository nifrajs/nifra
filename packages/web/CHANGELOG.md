# @nifrajs/web

## 4.0.1

### Patch Changes

- bbb2b27: Client navigation works on a page served from a native webview's own scheme, such as Capacitor's
  `capacitor://localhost` on iOS: link clicks, prefetch, `navigate()` and `<form method="post">` stay
  in-app there instead of the click being swallowed. Whether a URL belongs to the app is decided by the
  document's scheme and host rather than `URL.origin`, which reads `"null"` for every non-special scheme,
  so a `javascript:` target is still never taken in. An opaque or `file:` page, where history cannot move
  to another path, leaves its links to the browser.
- 2957acd: The credential scan no longer reads a ternary as an assignment. In
  `mode === "signup" ? "new-password" : "current-password"` the tail of `"new-password"` was taken for a
  key named `password`, and in `ready ? config.apiKey : "..."` the branch was taken for an `apiKey:` key,
  so a client build and `nifra check` (NF-C032) failed on a plain string. A quoted name must now be the
  whole string, and a name after a ternary's `?` or a member access's `.` is not a key. An object key
  inside a ternary branch, a quoted JSON key and a property assignment are still checked.
- 4bd292a: A static route file beside a dynamic one builds again: `users/me.tsx` next to `users/[id].tsx`, or a
  `[lang]/` tree next to `about.tsx`, no longer fails `buildManifest` with "overlapping routes". The path
  they share goes to the more specific route, in the router's own order (static, then mixed, then param,
  then wildcard, segment by segment), and each keeps the paths only it serves. Two routes of one shape
  that share a path, such as `users/[id].tsx` and `users/[slug].tsx`, still fail at boot, because one of
  them could never be served.
- 55e813b: The browser zone guard no longer refuses an extensionless import of a dotted source file. `import { x } from "../lib/calendar.shared"` (or `./date.utils`) was read as an asset with the extension `.shared`, judged by its bare path, refused, and then reported as "missing from the graph" once Bun loaded the real `.ts` file, so a `*.shared.ts` module outside the zone folders failed the client build and the dev server. Zone suffixes are no longer treated as asset extensions, and a path that names no file on disk is left to the source-file check, which judges the file Bun actually resolves.
  - @nifrajs/core@4.0.1
  - @nifrajs/island-trigger@4.0.1

## 4.0.0

### Major Changes

- 22e2af8: feat(web)!: client builds fail on what looks like a credential

  Every client build (Bun and Vite), every `public/` copy and every prerendered page and `_data.json`
  is scanned before it is written. The build fails, naming the file and line, on:

  - a PEM private key, a URL with a password, or a known secret token format (AWS access keys, Stripe
    secret and webhook keys, GitHub, Slack, OpenAI, Anthropic, SendGrid, Twilio, Mailgun and npm tokens,
    service-role JWTs); publishable keys are not flagged;
  - a random-looking string assigned to a secret-like name (`apiKey`, `clientSecret`, ...) in the app's
    own browser code;
  - the value of a build environment variable that is not public, raw or URL, JSON, HTML or base64
    encoded, when its name says it is a secret or the value looks random.

  A finding in a bundle names the module it came from. The report never prints the value. A reviewed
  false positive is exempted with `secretExemptions` on the build options (`nifra.config.ts` for
  `nifra build`): `{ rule, file, reason }`, or `{ rule: "private-env-value", env, reason }`. There is no
  exemption by value. `prerenderRoutes` takes the same exemptions as `secrets`. `@nifrajs/web/zones`
  exports the scanner as `scanForSecrets`.

- 214d674: feat(web)!: an app is split into zones, and the browser build admits only browser code

  An app's files live in `routes/`, `frontend/`, `backend/`, `shared/` and `public/`. A route is two
  files: `x.tsx` (or `.svelte`/`.vue`) is the page the browser receives, and `x.backend.ts` holds what
  only the server runs - `loader`, `action`, `middleware`, `getStaticPaths`, `revalidate` and the other
  server exports, a layout's `gate` and `shouldRevalidate` included. `_layout.backend.ts` exports a
  directory's `middleware`; `_middleware.ts` is retired. `@nifrajs/web/route-manifest` exports the
  placement table as `FRONTEND_ROUTE_EXPORTS` and `BACKEND_ROUTE_EXPORTS`.

  Every browser build and dev server - Bun and Vite - refuses `backend/`, a route's backend half, server
  packages, and first-party code that belongs to no zone, naming the import chain that reached it.
  After bundling, the build checks the finished module graph and every emitted file (code, CSS, assets
  and source maps) and writes nothing it cannot trace to browser code. A workspace package declares its
  side with `"nifra": { "environment": "frontend" | "backend" | "shared" | "library" }`.

  Server builds hold the same rules from the other side: every first-party file belongs to a zone,
  backend code never imports frontend code, and shared code imports only shared code and third-party
  packages, never a server built-in. A server bundle also refuses a built-in its target cannot load: a
  `node:` or `bun:` import kept in an edge worker, or a `bun:` import kept in a Node server. The Vite
  server build runs the zone rules through `viteServerZoneGuard` from
  `@nifrajs/web/plugins/vite-leak-guard`.

  Browser code - a route's frontend half, `frontend/` and `shared/` - may read only `NODE_ENV`, the
  bundler's `import.meta.env` flags (`MODE`, `DEV`, `PROD`, `SSR`, `BASE_URL`) and variables named with
  the public prefix (`PUBLIC_` unless `publicEnvPrefix` says otherwise). Any other `process.env`,
  `import.meta.env`, `Bun.env` or `Deno.env` read fails the build and the dev request, naming the
  variable. Strings, comments, JSX text and Markdown code samples that mention a variable are not reads.

  `@nifrajs/web/zones` exports the classifier and the rules every build, dev server and `nifra check`
  share: `createZoneClassifier`, `browserDenial`, `importAllowed`, `importRuleMessage`,
  `privateEnvReads` and `privateEnvReason`.

  Removed: the `*.server` file convention, the `@nifrajs/web/plugins/vite-server-only` export and
  `SERVER_ONLY_MODULE`. The opt-in marker import is `@nifrajs/web/backend-only`, its brand type is
  `BackendOnly<T>`, and the dev diagnostics are `NIFRA_BACKEND_ONLY_IN_CLIENT` and
  `NIFRA_BACKEND_IN_CLIENT`.

- 4b8d8de: feat(web)!: everything a route sends to the browser passes a declared output schema

  A route's backend half declares what its loader and action send to the browser:
  `export const loaderOutput = t.object({ ... })` and `export const actionOutput = ...`. A boundary
  loader declares `boundaryLoaders[name].output`, and a server function `serverFn({ output }, fn)`.
  Before the page renders and before anything is serialized, the data is projected through its schema:
  keys the schema does not declare are dropped, at every depth, even when the schema itself would accept
  them, so the component and the browser see the same value. A declared field of the wrong shape fails
  the request with a 500 whose message names the field's path, never its value. A loader that returns
  data without an output schema fails the request; one that returns nothing, redirects or answers with
  an error status needs none. A loader, action, boundary loader or server function that returns a 2xx
  `Response` is refused, since its body would bypass the schema.

  A deferred value is declared with `t.deferred(schema)`, and what it resolves to is projected and
  validated by `schema` before it streams. A deferred value the schema does not declare as one is
  refused.

  An output schema that names a field such as `password`, `passwordHash`, `secret`, `token`, `apiKey`,
  `privateKey` or `ssn` fails the route when it loads, unless the field is wrapped in
  `t.declassified("why it may reach the browser", schema)`. `@nifrajs/web/zones` exports the name test
  as `isSensitiveFieldName`.

  Projection reads a nifra schema's JSON Schema, or a Standard JSON Schema such as zod's. A schema that
  exposes neither keeps whatever its own `validate` returns.

  The scaffolded site and ISR routes declare their loader and action output schemas.

- 6c978a1: feat(web)!: the Cloudflare Pages build target is `cloudflare`

  `BUILD_TARGETS` and `buildTarget` / `buildTargetVite` name it `"cloudflare"` (it emits the same
  `_worker.js` + `_routes.json` deploy directory). `"cf-pages"` is refused with the new name.
  `parseBuildTarget(value)` returns a string as a `BuildTarget`, or throws with the same message.

- 38cf032: feat(web)!: Vercel builds use the Build Output API, and generated entries pass the client address

  - The `vercel` target emits the Build Output API v3 layout: `config.json`, `static/` (assets and
    public files) and an edge function at `functions/index.func/`, ready for `vercel deploy --prebuilt`.
    `planBuildTarget` reports the new `outputFile` and a `staticDir` for every target.
  - The generated Bun, Node and Deno server entries pass the socket peer to `app.fetch`, so
    `c.clientIp` and `rateLimit`'s default key work in a built app.
  - Edge bundles (`cloudflare`, `vercel`) accept `node:async_hooks`, `node:buffer`, `node:events`,
    `node:util` and `node:assert`, which those runtimes provide.

### Minor Changes

- 963694f: `@nifrajs/web/cdn` puts a CDN in front of nifra pages and purges it by tag.

  - `withCdn(app, { provider })` wraps an app or a `withISR` handler. Every page a shared cache may hold gets the CDN's tag header (the route's `revalidateTags` plus a tag for the page's path) and the CDN's TTL from the route's `revalidate`; browsers get `public, max-age=0, must-revalidate`. Every other HTML response, drafts included, is marked no-store for the CDN. Over `withISR`, the CDN is given only the freshness the page has left.
  - Providers: `cloudflareZone`, `cloudflareWorkersCache` (refuses a host-routed app, since Workers Cache keys by path), `vercel` (`invalidateByTag` from `@vercel/functions`, or the REST API; invalidate by default) and `fastly` (soft purge by default). `defineCdnProvider` builds any other.
  - Purges are coalesced for 250 ms, chunked to each provider's per-call limit, sent one call at a time, and retried on 429 or 5xx with capped backoff that honors `Retry-After`.
  - `revalidateEndpoint({ cdn })` purges the origin store, then the CDN, and answers `200` when the CDN accepted, `202` when the purge is queued, and `502` with `retryable` when the CDN refused. It also takes a batch `{ "paths": [...], "tags": [...] }` of at most 100 paths and 32 tags. `createInvalidator` does the same from app code.
  - `revalidateTags` may be a function of the route's params and URL, for tags per page. Invalid tags it returns are dropped with one `NIFRA_CDN_TAG_INVALID` warning per route.
  - `isCacheablePage` is exported: the one rule ISR and the CDN cache by.
  - New error codes: `NIFRA_CDN_HOST_ROUTED`, `NIFRA_CDN_TAG_INVALID`, `NIFRA_CDN_RATE_LIMITED`, `NIFRA_CDN_PURGE_FAILED`.

- a0cfffa: `export const clientIp = "platform"` in `nifra.config.ts` makes a `cloudflare` or `vercel` build read `c.clientIp` from the header that platform's edge overwrites (`cf-connecting-ip`, `x-real-ip`), so per-caller middleware such as `rateLimit` works there. Without it an edge build still has no caller address; Bun, Node and Deno builds use the socket peer either way. `buildTarget` and `generateServerEntry` take the same `clientIp` option. Site scaffolds declare it.
- 93e5e7f: Errors come with a prompt to paste into a coding agent: the error, where it is, the recognised cause, one fix, and steps that end in a check the agent runs itself (`nifra_errors` with a `since` cursor, then `nifra check`). App-supplied text is fenced and labeled as data, paths are project-relative, the home directory never appears, and the prompt is capped at 8000 characters.

  - Codes with more than one right fix (`NIFRA_BACKEND_IN_CLIENT`, `NIFRA_BACKEND_ONLY_IN_CLIENT`, `NIFRA_OUTPUT_SENSITIVE_FIELD`, `NIFRA_OUTPUT_UNDECLARED_DEFERRED`, `NIFRA_OUTPUT_RAW_RESPONSE`, `NIFRA_OUTPUT_SCHEMA_MISMATCH`) list each as a labeled `fixOptions` entry on the `Diagnostic`, with one prompt per option.
  - The dev overlay has a Copy prompt button per fix. A page load whose render throws gets the overlay on both dev pipelines; data requests and API calls keep the app's JSON 500.
  - A dev page that reports a browser error shows a badge listing that page's errors with their code, message, codeframe, fix and Copy prompt buttons. It renders in a closed shadow root, loads under the page's CSP (nonce, exact URL, or `'strict-dynamic'`), is only fetched once a page errors, and turns off with `nifra dev --no-indicator`, `export const dev = { indicator: false }` in `nifra.config.ts`, or `indicator: false` on `createDevServer`/`createViteDevServer`.
  - `nifra errors --prompt` (and `nifra_errors` with `prompt: true`) prints the prompt for the newest entry; `--id` picks an entry and `--option` picks a fix by its label.
  - `@nifrajs/web/diagnostic-prompt` exports `buildFixPrompt`, `fixPrompts` and `catalogFixPrompts` without Node APIs, for use in a browser bundle.

- 4936309: feat(i18n): one locale registry and locale-prefixed routing; feat(web): PWA manifest builder

  `defineLocales()` declares each locale once - URL segment, BCP-47 tag for `Intl`, `hreflang` value,
  writing direction and native name, each defaulted from the segment - and marks unfinished
  translations `draft`. It validates tags, segments and `hreflang` uniqueness at definition and gives
  `served`, `get()`, a catalog fallback `chain()` (`fr-CA` → `fr` → default) and `documentMeta()` for a
  route's `<html lang>`/`<html dir>`. `localeDirection()` derives the direction from an explicit
  script, a right-to-left language, or the runtime's likely script.

  `@nifrajs/i18n/routing` adds `defineI18nRouting(locales)` - the URL half of i18n next to
  `negotiateLocale`'s detection half. Pure and dependency-free: prefix, strip and read locale prefixes
  (served locales only, case-insensitive, so `/frank` never reads as French and a draft's prefix is an
  ordinary segment); `alternates(path, { origin?, locales? })` returns the page's canonical URL and its
  `hreflang` links - absolute or root-relative, limited to the locales the page exists in, listed in
  registry order so every page of a cluster agrees, with `x-default` when the default is listed; and
  `matchSegment()` checks a `[lang]` route segment for a route `middleware` guard, answering not-found for
  an unknown or draft value and a redirect for the default's prefix or a wrong case. No path it builds
  can start with `//` or `/\`. No regex runs on request input.

  `@nifrajs/web/pwa-manifest` adds `pwaManifest()` - the declarative PWA half next to the
  service-worker generator. Pure builder for `manifest.json` bytes (names, scope defaulted
  from `start_url`, icons/screenshots/shortcuts, colors) with fail-loud validation of spec
  shapes, plus `serializeManifest()` and the `<link rel="manifest">` tag helper.

- e8270d9: feat(web): SSR loader, action and boundary calls through `ctx.api` now carry the page request's
  platform identity. A backend reached from a loader sees the visitor's `c.clientIp` (derived under the
  page app's `server.clientIp` trust declaration), `c.env` and `c.waitUntil`, so per-visitor rate limits,
  audit logs and bindings work during SSR. Headers are never copied: a loader call stays anonymous unless
  the loader passes `cookie` or `authorization` itself. `inProcessClient()` / `testClient()` used outside a
  render keep dispatching with no platform.

  New seams in `@nifrajs/core/mount`: `NIFRA_BACKEND_BIND_PLATFORM` (returns a platform-bound view of an
  in-process client) and `NIFRA_PLATFORM_CLIENT_IP_DERIVED` (marks a platform whose `clientIp` an enclosing
  server already derived, so a backend with its own `clientIp` trust keeps it instead of re-reading
  forwarding headers a synthesized request does not carry).

- d942c33: feat(web): a loader or action sets response headers and cookies through `ctx.set`. It has `headers`,
  `cookie()`, and `deleteCookie()`, the page counterpart of a route handler's `c.set`.
  `LoaderResponseControls` is exported from `@nifrajs/web` and `@nifrajs/client`.

  - `ctx.set.headers` applies to the rendered document. It is not applied to a redirect, a status page,
    an error page, or a navigation data response.
  - Each loader has its own header record. They merge layouts root to leaf, then the page loader, then
    the action, so the most specific writer wins a name whichever loader settles first.
  - `content-type`, `set-cookie`, `location`, the transport headers, and the `x-nifra-` prefix are
    refused. So is a name that is not an HTTP token, and a value with a line break, a control
    character, or a character outside Latin-1. The error names the header, never its value.
  - `ctx.set.cookie()` uses the same secure defaults as `c.set.cookie` and rides every outcome,
    including a thrown `Response`. A queued cookie makes the response `cache-control: private, no-store`
    - the document, a redirect, a status or error page, a hand-built `Response` - and keeps the page out
      of `withISR`.
  - The controls close when the loader or action settles. A later write throws.
  - `enableDraft(ctx, secret)` works from a loader or action.

  Behavior changes:

  - A navigation data response, from a loader or an action, is now always
    `cache-control: private, no-store` with `vary: x-nifra-data`. It shares its URL with the document,
    so a cache keyed on the URL must not store it.
  - A document that carries loader headers has `x-nifra-data` added to its `vary`.
  - `withISR` stores a page whose only `vary` token is `x-nifra-data`, and replays `x-robots-tag`.
  - `LoaderContext` and `LoaderArgs` have a required `set`. A test that builds one by hand needs to
    supply it.

- 8e30090: feat: a mount nifra cannot analyze is a declared known gap, not a silent hole. Routes behind
  `mount()` and `mountFetch()` are invisible to route reflection, so capability assurance could not
  see them and said nothing. Both now take `opaque: "<reason>"`, and so does a `createWebApp`
  `mounts` entry. Capability assurance lists a mount with a reason as a known gap
  (`report.gaps`, `{ kind: "opaque-mount", path, reason }`): `nifra check` and
  `nifra capabilities check` print it on every run, and it fails nothing and lowers no level. A mount
  on the analyzed app without a reason fails with the new `opaque-mount-undeclared` finding, which
  suggests `merge()` for a nifra `server()` and `opaque` for anything else. A mount whose app publishes
  composed evidence (the API `createWebApp` mounts) is not reported. `webProjectEvidence` accepts a
  `mounts` entry without an evidence provider when it declares `opaque`. New exports:
  `reflectMounts` and `ReflectedMount` from `@nifrajs/core/reflection`, `CapabilityGap` from
  `@nifrajs/core/capabilities`; project evidence snapshots gain an optional `mounts` list, absent for
  an app with no mounts.
- 6d20355: feat(core): a path param can say which values it accepts, written in braces after the name. A
  request whose value does not fit is not served by that route:

  ```ts
  app
    // /users/me is its own route; /users/42 is this one; /users/ada is a 404
    .get("/users/me", () => ({ me: true }))
    .get("/users/:id{[0-9]+}", (c) => ({ id: Number(c.params.id) }))
    // a list of values, and a count
    .get("/img/:size{thumb|full}/:file", (c) => ({
      size: c.params.size,
      file: c.params.file,
    }))
    .get("/countries/:code{[A-Z]{2}}", (c) => ({ code: c.params.code }))
    // inside a segment, and optional at the end of a path
    .get("/files/:name.:ext{png|jpg}", (c) => ({
      name: c.params.name,
      ext: c.params.ext,
    }))
    .get("/posts/:page{[0-9]+}?", (c) => ({ page: c.params.page ?? "1" }));
  ```

  - A constraint is one character class with an optional count (`[0-9]`, `[a-z0-9_-]+`, `\d{4}`,
    `\w{2,8}`), or a list of two or more values (`png|jpg|webp`). A class holds letters, digits, ranges
    of them, `\d`, `\w` and `. _ ~ ! $ & ' ( ) + , ; = @ -`; there is no negated class and a count
    starts at one. Anything else in braces (`:id{int}`, `:id{.+}`, `:id{[0-9]+|[a-z]+}`) is literal
    text, as before.
  - The param stays a `string`, keyed by its bare name: `Params<"/users/:id{[0-9]+}">` is
    `{ id: string }`.
  - The value is checked as it was sent, before percent-decoding. `/users/4%32` does not fit
    `:id{[0-9]+}`; a broader route beside it serves that request.
  - The narrowest route answers, whatever the order of registration: literal text, then a list, then a
    class, then a bare `:param`, then a wildcard. Between two constraints of a kind, the one that
    accepts fewer values is tried first. A method the narrowest matching route does not have answers
    `405`, as it does for a literal route beside a param route.
  - Two spellings of one constraint (`[0-9]+`, `\d+`, `[0-9]{1,}`) are one route: the same method
    registered on both throws `DUPLICATE_ROUTE`.
  - Inside a segment the text around the params is placed first and each value is then checked; the
    router does not look for another split.
  - `routePatternOverlap` takes constraints into account: `/users/me` and `/users/:id{[0-9]+}` do not
    overlap.
  - `@nifrajs/core/pattern` exports `paramConstraint(text)`, which reads a constraint at the start of
    `text`, and the `ParamConstraint` type. A param part of a compiled mixed segment carries its
    constraint as `c`.

  feat(edge): the compact server accepts the same constraints.

  feat(schema): `toOpenAPI` writes a constrained param into the path template by its bare name
  (`/users/{id}`). Its schema is `{ type: "string", pattern }` for a character class and
  `{ type: "string", enum }` for a list of values; a declared `params` schema still takes precedence.

  feat(client): a constrained param is passed by its bare name, `api.users({ id: "42" }).get()`. Two
  param routes at one position (`/users/:id{[0-9]+}` beside `/users/:slug`, or a param beside a
  wildcard) are each callable, picked by the name of the key. The client does not check a value
  against its constraint.

  feat(cli): `nifra check` accepts a supported constraint and keeps reporting other text in braces
  (`NF-C026`); `NF-C024` and `NF-C025` follow the router's reading of a constraint. `nifra routes` and
  the generated client calls print the bare name. `nifra scaffold` refuses a page path that carries a
  constraint.

  feat(testing): `runAdversarialContract` builds a request path whose values satisfy each param's
  constraint, and fills a part-literal segment (`/files/:name.json`) param by param.

  feat(web): a route file name that would read as a param constraint (`[id]{a|b}.tsx`) is refused at
  build time with a message that names the file. `llms.txt` prints client calls with the bare name.

- ba5dd1c: feat(web): a directory's route middleware runs before every page in it and below.

  ```ts
  // routes/account/_layout.backend.ts
  import { type RouteMiddleware, redirect } from "@nifrajs/web";

  export const middleware: RouteMiddleware = ({ request }) => {
    const signedIn =
      request.headers.get("cookie")?.includes("session=") ?? false;
    return signedIn ? undefined : redirect("/login");
  };
  ```

  Route middleware runs on the server, outermost first, before the layouts' loaders (gates included)
  and the page's loader or action, for document requests, client navigations and form posts alike, and
  before a nested `_404` in its directory. It returns nothing to let the request through, or returns or
  throws a `redirect()`, a status such as `notFound()`, or a `Response` to answer with it. `ctx.set` adds
  headers and cookies, and `ctx.params` holds the params of its directory's URL prefix. It never reaches
  the client bundle, and a directory may export it from `_layout.backend.ts` without a frontend layout.

- d50f73e: feat: generated route types

  Every route file gets a generated `Route` namespace, imported from `./+types/<name>` by both halves
  of the route:

  ```ts
  // routes/blog/[slug].backend.ts
  import type { Route } from "./+types/[slug]"
  export const loaderOutput = t.object({ title: t.string() })
  export async function loader({ api, params }: Route.LoaderArgs) { ... }

  // routes/blog/[slug].tsx
  import type { Route } from "./+types/[slug]"
  export default function Post({ data, params }: Route.ComponentProps) { ... }
  ```

  `Route.Params` comes from the path (`[id]`, optional `[[lang]]`, catch-all `[...path]`).
  `Route.LoaderData` and `Route.ActionData` are the output types of `loaderOutput` and `actionOutput`,
  so a component is typed with exactly what reaches it. `Route.LoaderArgs` types `api` from the app's
  `backend/app.ts`, which `.nifra/types/register.d.ts` registers once with `@nifrajs/client`'s new
  `Register` interface; no route imports the backend for its types.

  `nifra types` writes the files to `.nifra/types` (and `--check` fails when one is stale); `nifra dev`,
  `nifra build` and `nifra check` refresh them, and `nifra dev` keeps them current as routes are added
  or removed. A route resolves `./+types/<name>` through `"rootDirs": [".", "./.nifra/types"]` in
  tsconfig, which the scaffolded site and ISR apps now carry; `nifra types` says so when it is missing.
  `@nifrajs/web/route-types` exports the generator.

- 085e852: On the Bun dev pipeline, an error thrown from a `.vue` or `.svelte` file names the line written in that file, in the browser and on the server: the overlay, the in-page badge, `nifra errors` and the fix prompts all point there.

  - `vueBunPlugin` and `svelteBunPlugin` attach their compile map while a dev server runs; `nifra build` output is unchanged.
  - `@nifrajs/web/plugins/kit` exports `withDevSourceMap` and `concatSourceMaps` for other compiler plugins to do the same.
  - Svelte's `hydration_html_changed` and `hydration_attribute_changed` warnings count as hydration mismatches. Vue's feature-flag warning, which names `__VUE_PROD_HYDRATION_MISMATCH_DETAILS__`, does not.

- ae815ab: The zone rules now cover files a client build copies or inlines without importing them:

  - New `viteAssetUrlGuard()` in `@nifrajs/web/plugins/vite-leak-guard`, which the Vite client build installs. It fails the build when a `new URL("...", import.meta.url)` in browser code names backend code, a route's backend half, a server function's source, or a file in no zone. It applies whatever the file's size, a `?inline` query, or a comment inside the call. Such a file is also never inlined from a stylesheet `url()`, so the output accounting names it.
  - An asset emitted from a `*.fn.*` file is refused: a server function reaches the browser only as its call stub.
  - A `.fn` file that is not a script module (`report.fn.vue`, `post.fn.mdx`) is a zone error that asks for a rename. Previously it was treated as a server function whose source the browser build would ship unchanged.

- 3442e1c: feat(web): `export const ssr = false` keeps a page's component off the server. The route is still
  matched, its layouts still render, its gates and loader still run and the data is still embedded;
  the server puts the page's `HydrateFallback` export in the page slot - or nothing - and the browser
  hydrates that before it renders the component with the data it already has. A client navigation to
  the page renders the component directly. `HydrateFallback` receives the component's props. The
  module is still imported on the server for its loader and options, so an import that needs a
  browser at load time belongs inside the component. `ssr = false` together with `hydrate = false`
  is refused when the page is rendered: nothing would render it. On Solid the layouts mount again
  when the component takes over from the fallback, as they do on any Solid route change.

  `assertRenderAdapterConformance` now also renders a chain whose leaf is a function returning
  `null` and requires the layouts around an empty page slot (check `"empty leaf"`). An adapter that
  cannot render such a leaf fails conformance.

  fix(web-react): the mounted router hydrates against the state it was mounted with. A router that
  changed before React reached the component - a client loader that answered first - no longer
  hydrates a tree the server markup never had; React renders the newer state right after.

- 8b99424: feat: the dev server keeps a feed of errors, logs and requests for coding agents

  `nifra dev` (Bun and Vite pipelines alike) records what happened while it ran and serves it to local
  tools:

  - Errors from every layer, each a structured diagnostic: SSR renders, loaders and actions, backend
    handlers, builds, the browser, hydration mismatches, and a crash of the server itself. Repeats of
    one failure collapse into one entry with a count; an entry recorded before the last file change is
    flagged `stale`, and a build error clears when the next build passes.
  - Console output from the server and from the browser.
  - One trace per request (method, path, status, duration, bytes, ISR status, its errors and log
    count). Every dev response carries `x-nifra-request-id`, and every entry from that request, server
    or browser, carries the same id.

  Each dev page carries a small inline script, first in `<head>`, that reports uncaught errors,
  unhandled rejections, failed script and stylesheet loads, console output and errors passed to
  `console.error`. Browser stacks are mapped to source through the dev server's own source maps, in
  Chrome, Firefox and Safari formats. The script is admitted by hash in a page's CSP (by the page nonce
  under Vite) along with its endpoint in `connect-src`; a page whose CSP allows no script gets none.

  The server writes `.nifra/dev-server.json` (owner-only) with its port and a per-run token, and a log
  under `.nifra/dev-server.log` that outlives a crash. The feed endpoints under `/__nifra/` answer only
  a loopback `Host` presenting that token; browser reports need a separate page token and a same-origin
  `Origin`, are size-capped and rate-limited. Values of non-public environment variables, keys, tokens,
  JWTs and credential headers are redacted before anything is stored. `record: false` on
  `createDevServer` / `createViteDevServer` turns the record and the log off. The feed's types, the
  discovery record reader and the redacting store are exported from `@nifrajs/web/dev-feed`.

  The dev overlay links each recognised error code to its section of the new error codes page. Dev only;
  production builds and responses are unchanged.

- 0e14068: fix(web): the client build fails on a Node built-in the bundler left as an external import

  Bun keeps a dynamic `import("node:fs")`, and a bare built-in such as `import("fs/promises")`, as an
  import in a browser chunk instead of bundling a polyfill. The import shipped and failed in the
  browser, and the Node built-in guard passed it because the module was in no output. The guard now
  reports such an import in the chunk its importer landed in, with the import chain, and names a bare
  built-in with its `node:` prefix.

  The Vite pipeline gives the same result: `viteBareBuiltinExternal()` from
  `@nifrajs/web/plugins/vite-leak-guard` keeps a bare built-in named instead of letting Vite replace it
  with an empty stub, so the guard fails the build there too. A package of the same name the app
  installed (`events`, `buffer`) still resolves to that package. `buildClientVite` adds the plugin.

- 5a63dd4: feat(web): pages can carry a strict Content-Security-Policy and still be cached.
  A per-request nonce makes every document unique, so nifra marks a nonce-bearing page
  `private, no-store` and no shared cache (`withISR`, a CDN) may store it. `createCspPolicy({ header })`
  is the cacheable alternative: pass it to `createWebApp({ csp })` (or `renderPage({ csp })`) instead of
  `nonce`. A document then carries a nonce only when it has a script specific to this request (a
  deferred value, or `meta` naming the nonce in `unsafeInlineScript`). Every other document is
  nonce-free, its constant inline scripts are allowed by sha256 hash, and its CSP header is the same on
  every request. `header` receives `sources`, the `script-src` list the document needs.
  `nifraScriptHashes(adapter)` returns the hashes for a policy set at a proxy or CDN. Passing both `csp`
  and `nonce` throws.

  The page-state handover is now one inert `<script type="application/json" id="__nifra-handover">`
  instead of an executable script that assigned `window.__NIFRA_DATA__` and its siblings, so page data
  needs no nonce or hash under any policy. The client entry assigns the same globals before anything
  reads them. Code that read those globals from an inline script running before the client entry must
  run after it, or read the handover element (`HANDOVER_ID`). `nifra assure --hydration` reads the new
  format. `RenderAssemblyCache` loses its `tailMid` and `tailData` slots.

  `withISR` warns once when it wraps an app created with `nonce`, since it can never store one of its
  pages. It also remembers, for its revalidate window, keys whose page answered `private` or
  `no-store` and skips the store lookup for them. A remembered key that turns cacheable is stored again.

- dfd19d8: feat(web)!: `withISR` no longer caches a page per query string by default.
  The default key was `origin + pathname + search`, so `?a=1`, `?a=2`, ... each stored a full page and
  anyone could grow the cache without bound. The new `query` option decides how a query string reaches
  the default key:

  - `"bypass"` (default): a request carrying any query parameter skips the cache. It is rendered fresh
    and never stored. A request without one is keyed on `origin + pathname`.
  - `["page", "sort"]`: those parameters join the key in any order (`?sort=new&page=2` and
    `?page=2&sort=new` share an entry). A request carrying any other parameter skips the cache, so a
    loader that reads it is never handed another request's page.
  - `"all"`: the previous behavior, one entry per distinct query string.

  `revalidateEndpoint` takes the same `query` option so a purged path's query is keyed the way it was
  stored. A purge of a query string the policy never caches returns `400` with `uncached_query`. A
  custom `key` on either still overrides the policy.

  Migration: pass `query: "all"` to both `withISR` and `revalidateEndpoint` to keep the old keys.

- 6393b1e: feat(web): `_loading.tsx` is what the page slot shows while a client navigation loads. A navigation
  still waiting on its data after about 120 ms swaps the page for the target route's nearest
  `_loading` - the innermost one above it whose layouts are already on screen, which are the layouts
  the two pages share; they stay mounted with their data. A `_loading` never renders outside a layout
  above it. A navigation that settles sooner goes straight to the new page, as does one with no
  eligible `_loading`; a change of search on the same path and a form submit keep the page. A newer
  navigation, a form submit, or a refresh of the page on screen takes over from a pending loading
  page, and a superseded navigation that fails later changes nothing. The
  component receives `pending` and no `data`. It is browser-only: the server never renders one, and an
  app without a `_loading` file ships no code for it. Where the browser runs view transitions, a
  navigation's transition ends on the loading page instead of holding the old page until the data
  arrives. `Manifest.loadings` lists the pages (`LoadingEntry`, each with the layouts it sits under)
  and `RouteEntry.loadingIds` the ones above each route. In a `buildClient` build every page links the
  loading pages' stylesheets.

  A file named `_loading` was an ignored underscore file before; one kept in a routes directory for
  another purpose is now a loading page.

  fix(web-solid): the mounted router renders the chain the router names while a navigation is pending,
  which is how a `_loading` page reaches the screen. A pending navigation on the same chain is still
  skipped until it settles.

- a158b74: feat(web): a page file under a mount fails at startup, at build and in `nifra check`, instead of
  answering with the mount's 404. A mount in front of the page router - the backend at `apiPrefix`, a
  `mounts` entry, or an `app.mount()` inside `use` - answers every request under its path, and its 404
  is final (`fallbackOn: 404` only tries the next mount), so a page there could never render.
  `createWebApp` now throws at startup, naming each file, the URL it serves and the mount; `nifra build`
  refuses to build; and `nifra check` reports `NF-C027` for a page under the backend's prefix, reading
  `apiPrefix` when `backend/framework.ts` exports it as a string literal (an `info` finding says so when it does
  not).

  `backend/framework.ts` can export `apiPrefix`, `apiStrip`, `mounts`, `csp` and `nonce`. `nifra dev`,
  `nifra build` (the generated server entry and the static prerender), `nifra mcp`'s render tool and the
  hydration gate pass the same set to `createWebApp`, and the render tool and the hydration gate now
  apply `use` as well. A field of the wrong type fails at load, naming it, and a value
  `nifra.config.ts` exports must be the one `backend/framework.ts` exports, or the build stops. `nifra routes`
  lists the backend under the configured prefix, at the served path when `apiStrip` is set.

  New exports: `preRouteMountPaths` from `@nifrajs/core/mount`; `shadowedPages`,
  `formatShadowedPages`, `normalizeMountPath` and `ShadowedPage` from `@nifrajs/web/route-manifest`;
  `SERVER_ENTRY_OPTIONS` and the `optionImports` option of `generateServerEntry` and `buildTarget` from
  `@nifrajs/web/build`.

  Upgrading: an app with a page file under its backend prefix (`routes/api/*` with a backend)
  started before and answered that page with a 404; it now fails to start until the file moves out of
  the prefix or the prefix changes.

- ee19d29: feat(web): a `_404.tsx` in a directory answers for that part of the app. `routes/admin/_404.tsx`
  renders for the unmatched URLs under `/admin` and for `notFound()` from the routes beneath it - the
  nearest one wins - inside the layouts at or above it, with their loader data. The layouts run as
  they do for a page, so a `gate` decides before anything renders. The page is served non-hydrated,
  and with `cache-control: private, no-store` once a layout loaded data for it. `Manifest.notFounds`
  lists these pages (`NotFoundEntry`, each with the `NotFoundScope` patterns it answers) and
  `RouteEntry.notFoundIds` the ones above each route.

  fix(web): a `_404.tsx` below the routes root no longer takes the place of the root one. Two route
  groups that each hold a `_404` for the same URL prefix are refused at boot, unless a directory that
  contains both holds one as well.

- 7e1e1c3: feat(web): `data-nifra-prefetch` picks when a link warms its route: `intent`, `viewport`, `render` or `none`.

  ```html
  <nav data-nifra-prefetch="viewport">
    <a href="/docs/routing">Routing</a>
    <a href="/reports/annual" data-nifra-prefetch="none">Annual report</a>
  </nav>
  ```

  The attribute goes on a link or on any element around it; the nearest one wins. `intent` (the
  default, as before) warms the route's code and loader data on hover or keyboard focus, `viewport`
  once the link scrolls into view, `render` as soon as a page shows it, and `none` never. An unknown
  value is `intent`. `viewport` and `render` links are found when the page loads and whenever the
  router settles (a navigation, a submit); a link the page adds in between warms on intent until
  then. It works under every adapter, and React's `<Link>` and `<NavLink>` take a `prefetch` prop
  that renders it.

  Prefetched data is now used by a click within 30 seconds of arriving; after that the click loads
  the route again. The page already on screen is no longer prefetched. `PrefetchMode` is exported
  from `@nifrajs/web`.

- bd11269: feat(web): a layout's `shouldRevalidate` decides whether its loader runs again on a client navigation.

  ```ts
  // routes/orgs/[org]/_layout.backend.ts
  export const shouldRevalidate: ShouldRevalidate = ({
    currentParams,
    nextParams,
  }) => currentParams.org !== nextParams.org;
  ```

  It receives the URL and params being left (`currentUrl`, `currentParams`), the ones being loaded
  (`nextUrl`, `nextParams`, every route param rather than only the layout's own), and
  `defaultShouldRevalidate`: `true` when a param the layout owns or the query changed. Returning
  `false` keeps the data the browser already holds; any other value, a returned promise included, runs
  the loader. A throw fails the navigation the way the loader's own error would.

  It runs on the server, on a client navigation that keeps the layout on screen while the browser
  holds its data. A document request, the revalidation after an action, and `router.invalidate()` run
  every loader without asking. A `gate` layout is never asked: it runs on every request. A page's
  `shouldRevalidate` is not read, because a page's loader runs on every navigation; query keys a page
  never reads belong in its `searchClientKeys`.

  `ShouldRevalidate` and `ShouldRevalidateArgs` are exported from `@nifrajs/web`.

- 64e7a42: fix(web): pages that `defer()` keep working under a nonce Content-Security-Policy.
  React, Solid and Preact stream inline scripts to reveal a Suspense boundary that resolves after the
  shell, and none of them carried the document's nonce, so a nonce CSP blocked them and the boundary
  stayed on its fallback. `RenderAdapter.renderToStream` now receives `{ nonce }` as an optional third
  argument (`RenderStreamOptions`), and every adapter that streams scripts applies it: React and Solid
  through their own `nonce` option, Preact on the one island-runtime script it streams. A script the
  app renders itself never inherits the nonce. Vue, Svelte and the vanilla adapter stream no scripts.
- d6f806f: An `*.svg?component` import compiles its file as markup only, for every framework:

  - JSX (React, Preact, Solid) spells braces, `>` and `=` in text and CDATA as character references. An exported stylesheet (`.st0{fill:#FFF}`, `a > b`) now compiles, and text such as `{...}` in a `<title>` renders as written.
  - Svelte spells braces in text and attribute values as character references, keeps a nested `<style>` or `<script>` as raw text, and refuses a directive attribute (`use:`, `on:`, `bind:`...) or a `svelte:` element.
  - Vue marks the root `v-pre`, so `{{ }}`, `:bound` and `v-` attributes are not compiled. A `<template>` tag is refused.
  - The file must be one well-formed `<svg>` element, with every attribute value quoted and nothing after the root. Anything else fails the build with a message naming the problem. The check is exported as `svgTemplateMarkup()`.

- 0f6babe: feat(web): a route can export a `handle`, and `useMatches()` reports the rendered chain on every adapter.

  ```tsx
  // routes/orgs/[org]/_layout.tsx
  import { useMatches } from "@nifrajs/web-react/router";

  export const handle = { crumb: "Organization" };

  export default function OrgLayout({
    children,
  }: {
    children: React.ReactNode;
  }) {
    const crumbs = useMatches().flatMap(
      (m) => (m.handle as { crumb?: string } | undefined)?.crumb ?? []
    );
    // ...
  }
  ```

  `useMatches()` lists the layouts being rendered, outermost first, then the page, each as
  `{ id, pathname, params, data, handle }`: the route file without its extension, the part of the URL
  it covers (never the query), the params it declares, its loader data (`null` without a loader), and
  its `handle` export. The server render and the browser report the same list, so a breadcrumb trail
  hydrates with no mismatch. `handle` is read from the module on each side and never serialized.

  While a `_loading` page is up it takes the page's place; a nested `_404` reports the layouts it
  renders inside; an `_error` page the server renders reports an empty list. The hook ships from each
  adapter's `/router` entry: an array on React and Preact, a `Ref` on Vue, an accessor on Solid and
  Svelte. An app that never calls it does not bundle it.

  The Preact, Solid, Vue and Svelte client mounts now pass `params` and `path` to the rendered chain,
  as the server render already did. `UIMatch` and `MatchChain` are exported from `@nifrajs/web`.

- 00f18bf: feat(web): `@nifrajs/web/vitals` reports Core Web Vitals from real users, each tagged with its route.

  ```ts
  import { reportWebVitals } from "@nifrajs/web/vitals";

  reportWebVitals((metric) => {
    const { name, value, rating, id, route } = metric;
    const body = JSON.stringify({ name, value, rating, id, route });
    void fetch("/api/vitals", { method: "POST", body, keepalive: true });
  });
  ```

  `reportWebVitals` measures LCP, INP, CLS, FCP and TTFB with Google's `web-vitals`, an optional
  peer dependency (`bun add web-vitals`), and reports each metric once its value is final, with the
  id of the route it belongs to (the id `useMatches` reports). `softNavigations: true` measures each
  client-side navigation as a page view of its own where the browser can (Chromium 151 and later),
  and `reportAllChanges: true` reports every change instead of the final value. It returns a
  function that stops reporting, and does nothing on the server.

### Patch Changes

- 86e2d0f: In Bun dev, deleting a route regenerates the client entry and runs the leak guard once instead of twice.
- 0e9b167: fix(web): a route's ISR freshness and tags stay between the app and its cache wrapper

  `x-nifra-isr-revalidate` and `x-nifra-isr-tags` carry a route's `revalidate` and `revalidateTags`
  to `withISR`. An app with no wrapper sent both to every visitor, and `withISR` passed them through
  on responses it did not store (a query string under the default policy, a keyless request, a page
  it refused to cache). `createWebApp` now emits them only once a wrapper attaches, and `withISR`
  removes them from every response it returns.

- bbdc5a1: fix(core, web): JSON request bodies are matched by media type

  A body is parsed as JSON when its `Content-Type` media type is `application/json` or an
  `application/*+json` type. A header that only mentions `application/json` in a parameter, such as
  `text/plain; x=application/json`, is no longer parsed as JSON; browsers send that type cross-origin
  without a preflight. Server functions apply the same comparison and answer such requests with 415.

- ef28ef9: The route manifest, generated route types, build plan, parity report, secret scan and zone graph list their entries in code-unit order, the same on every machine and in every locale.
- 216fe27: fix(web): a redirect during a client navigation or form post lands on its target without a reload.

  A loader, gate or middleware that answered a client navigation with `redirect()` had the redirect
  followed by `fetch`, so the router rendered the target's data under the route it was navigating to, at
  that route's URL. A data request now answers a redirect with a `204` carrying `x-nifra-redirect` and the
  redirect's own headers, `Set-Cookie` included, and a same-origin target travels as a path. The client
  router loads that target in place: the address bar shows it, replacing the entry a navigation added or
  adding one after a form post, and `pendingPath` moves to it while it loads. A redirect to another origin
  or to a `#fragment` loads as a document and replaces the entry it answered; a target whose scheme is not
  `http:` or `https:` is never loaded, and the page navigated to loads as a document. A form whose action has run
  is never posted a second time: when loading the page that shows the result fails, that page loads as a
  document instead.

- 08250bf: `nifra build` no longer fails its development/production css parity check when a tool such as `wrangler pages dev`, Vercel or SvelteKit has left bundles in a dot-directory (`.wrangler`, `.vercel`, `.svelte-kit`) inside the app.
- 8fa902c: The private-env check reads every Svelte and Vue script block however its closing tag is spaced (`</script >`), CSP hashing finds the hydration head's inline scripts the same way, and development parity ends an SFC comment at `--!>` as a browser does.
- 0dac7ec: Checking a Svelte or Vue file for private environment reads, and the development parity check, take time in proportion to the file's length when an HTML comment or a `{{` interpolation is left open.
- b64c3ee: fix(web): the identity preflight behind `nifra check`, `nifra doctor` and the build now scans every
  package declared in `"nifra": { "singleCopy": [...] }`, not only the built-in identity-sensitive set.
  A declared package installed at two versions is a fatal `version-skew` finding with the same
  remediation as a framework skew (align the ranges; nifra never redirects across versions), and one
  version at two paths is reported as deduplicated.

  feat(core): `@nifrajs/core/single-copy/register` no longer skips silently. Each declared package it
  cannot collapse - a version skew, or a linked file with no counterpart in the app's copy - prints one
  warning per process naming both copies, both versions and the reason. Strict mode turns that into a
  startup failure: declare `"singleCopy": { "packages": [...], "strict": true }` or set
  `NIFRA_SINGLE_COPY_STRICT=1`. `SingleCopySkip` gains optional `to`, `fromVersion` and `toVersion`;
  `SingleCopyOptions` gains `strict` and `onSkip`; new exports `readSingleCopyStrict` and
  `SINGLE_COPY_STRICT_ENV`.

- dc2d4d3: fix(cli): duplicate-install findings name a copy reached through a symlink out of its install

  When an importer reaches a copy of an identity-sensitive package through a symlink that points
  outside its own install (another project's `node_modules` linked into a shared package, or a
  `bun link`), `nifra doctor` prints a `links:` line with each link and its target, and the
  `nifra check` duplicate-install diagnostic names the link on that copy and lists it ahead of both
  fixes. The identity preflight carries it as `copies[].links` and `provenance`. Package-manager store
  links inside an install are not reported.

- 81c720e: fix(client): a segment that is part literal, part param is callable through the typed client

  A route such as `/files/:name.json`, `/post-:id` or `/v:major.:minor` could not be reached through
  the typed client: `:name.json` was typed as a param named `name.json` whose call sent the value
  without `.json`, and `post-:id` was typed as a property that sent the pattern text itself. Such a
  segment is now a call with the segment as the request carries it:

  ```ts
  await api.files("report.json").get(); // GET /files/:name.json, c.params.name === "report"
  await api("post-42").get(); // GET /post-:id
  await api("v1.2").get(); // GET /v:major.:minor
  ```

  - The argument is typed as the segment's literal text around any string (`` `${string}.json` ``), so
    `api.files("report.txt")` does not compile. A constraint is not part of the text:
    `/img/:id{[0-9]+}.png` takes `` `${string}.png` ``, and the server decides whether the value fits.
  - The value is sent as one encoded segment, as a param value is: a `/` in it never adds a path level.
  - A static segment at the same position keeps its exact text (`api.files("index.json")` is
    `/files/index.json` when that route exists, which is the route the server picks), and a
    whole-segment param keeps its call by name (`api.files({ id })`).
  - Two such segments at one position that accept the same text resolve to the types of the one
    registered first.
  - `@nifrajs/core` exports `RequestPath<Path>`, the same reading for a whole path:
    `RequestPath<"/files/:name.json">` is `` `/files/${string}.json` ``, a constraint reads as
    `${string}`, and a path ending in optional params is one template per form.
  - The cli's route listings and the generated `llms.txt` print the call the same way
    (`` api.files(`${name}.json`) ``), and print an unnamed wildcard as `({ "*": rest })`.

- 0150ed4: fix: Vite dev keeps a page's response headers, and a CSP page still boots

  Under `nifra dev --vite` an HTML page reached the browser with only a `content-type`: the cookies a
  loader set, the Content-Security-Policy, `cache-control`, `vary` and the `x-nifra-*` headers were
  dropped, where the Bun dev pipeline kept them. They are kept now. On a page with a CSP, the tags
  Vite adds (its HMR client, a framework's refresh preamble, the `<style>` it injects for each imported
  stylesheet) carry the page's nonce - or a fresh one on a hash-based page - and each directive that
  governs them names it, unless that directive already allows inline. Dev only; production responses
  are unchanged.

- ea2ee87: The Bun dev server refuses a backend file of any type that browser code imports, such as a `.sql` or `.pem` file imported `with { type: "text" }`, as the production build does.
- 85d636b: In a client build, a bare `process.env` (one not followed by a baked `PUBLIC_*` name or `NODE_ENV`) is now an empty object. It was the string `"({})"`, so `"X" in process.env` threw a `TypeError` in the browser and `Object.keys(process.env)` listed characters. Reading any other variable still yields `undefined`.
- bfe29b6: The CSS Modules transform scopes the keyframe name in a vendor-prefixed `-webkit-animation` / `-webkit-animation-name` declaration and in a declaration that follows a comment (`/* slow */ animation: spin 3s`). Before, both kept the unscoped name and the animation silently did not run.
- 87783f0: On the Bun pipeline's dev server, an edit to a module imported through a path alias (`@/components/Button`, `~/lib/x`, `#internal/x`) is picked up by server rendering. Before, only relative imports were re-evaluated, so SSR kept rendering the aliased module as it was when the server started. An alias shaped like a package name (`@app/x`, `src/x`) is still not recognized.
- 135aba4: A page, action or data request rendered in draft mode answers `cache-control: private, no-store` and advertises no ISR freshness, whatever `cache-control` its loader set, so neither `withISR` (with or without its own `draftSecret`) nor a URL-keyed CDN stores unpublished content for the next visitor.
- 47b0d65: fix(web): a hydrating page with an empty `clientEntry` throws instead of rendering `<script type="module" src="">`.
  An empty `src` resolves to the page's own URL, so the browser would load the document as a module.
  Rendering a hydrating page with an empty or missing entry now throws a `TypeError` naming the fix,
  from `renderPage` and from `createWebApp` pages alike. A `hydrate: false` page never references the
  entry and still renders without one.
- e32268d: fix(web): portable public-directory serving and required endpoint secrets

  `publicDir()` now serves files on Node and Deno as well as Bun, sets `content-type` from the file
  extension, sends `x-content-type-options: nosniff`, and never serves dot-prefixed paths other than
  `/.well-known/`.

  `revalidateEndpoint()` and `previewEndpoint()` throw at construction when `secret` is empty or
  missing. The ISR starter answers 404 on its revalidate route until `REVALIDATE_SECRET` is set.

- 432fec3: In production a server-rendered `_error` page receives `{ name: "Error", message: "Internal Server Error" }` instead of the thrown error's own name and text, which can carry a connection string or a query. Development still shows the real error.
- 8f1b780: A generated `server-manifest.ts` counts as framework output wherever the build writes it, so `nifra check` and editor diagnostics no longer report its route imports when it sits under `backend/`.
- dcc9ff6: The generated client entry reads page state only from the server's own `<script type="application/json">` handover (the last one in the document), and sets only the page-state globals it names. Page content that carries an element with the same `id` - sanitized user HTML, say - no longer reaches `window`.
- c49882f: `unsafeInlineScript()` code is emitted exactly as written, so a script with a comparison (`if (innerWidth < 600)`) runs instead of failing to parse, and server rendering matches what a soft navigation applies. Code containing `</script` or `<!--` (any case) is refused with a `TypeError`, both when the descriptor is built and when the head renders. Write `<\/script` inside a string literal instead. Inert `head.script` content (JSON-LD) is escaped as before.
- 28e091f: perf(web): a page with no layouts, and a layout loader that returns a plain value, render without
  extra promise turns. A layout loader may still return a promise, a thenable, or a promise from
  another realm; each is awaited exactly as before, and a loader that throws synchronously fails the
  page the same way a rejected one does.
- 046e79d: `/llms.txt` and `/llms-full.txt` list backend routes only when the backend is served over HTTP at `apiPrefix`; a backend the loaders call in-process (`apiPrefix: ""`) is not described. An app route at either path takes precedence instead of failing to boot, each text is built once per app, and the new `llmsTxt: false` option registers neither path.
- 293d3c8: A `Date` a loader, action or server function returns passes its output schema as the ISO string the browser receives, so a timestamp column is declared `t.string()`. The page also renders on the server with that string, the same value it hydrates with.
- 0cd5f6e: A large `prerenderedPaths` set no longer rides in every page. Over 4 KB of JSON, `createWebApp` serves the set once from `/__nifra/prerendered.json?v=<version>` (cached for good at that versioned URL) and pages hand over only the URL; the client router fetches it once, on load, and uses it as before. `prerenderRoutes` writes the file into a static output whenever its pages reference it. Smaller sets are still inlined, unchanged.
- 2245bee: The development/production parity check lists a public file by the same percent-encoded URL the build records for it. A build with a public file whose name holds a space or a non-ASCII character (`My Logo.png`, `café.txt`) no longer fails parity.
- feeec4a: fix(web): a client navigation that changes the query re-runs the layout loaders. A layout loader was
  kept whenever the params its layout owns were unchanged, so one that reads `ctx.search` or the request
  URL went on showing the previous query's data. Keys that no loader should see belong in the route's
  `searchClientKeys`, which still skips the request entirely.

  After an action that redirects, every layout loader of the target runs, the same as the revalidation
  after an action that does not redirect. `submit(action, body, { revalidate: false })` keeps the layout
  data an ordinary navigation would.

- 3eb6339: The build's credential scan stays fast on a long unbroken run of letters and digits, such as an inlined base64 asset, instead of slowing the build to minutes.
- f784c32: fix(web): a field named `apiToken` counts as sensitive

  `isSensitiveFieldName` matches `apiToken` in any casing or separator (`api_token`, `API-TOKEN`) and
  any name ending in it (`githubApiToken`), like `apiKey` and `accessToken`. An output schema that
  declares one fails the route when it loads unless the field is wrapped in `t.declassified`,
  `nifra check` reports it, and the build's secret scan treats a literal assigned to one as a
  credential.

- e3b2b97: fix(web): the server build fails when `clientEntry` is missing.
  `buildServer`, `buildServerVite`, and `generateServerManifest` throw a `TypeError` when `clientEntry`
  is not a string - for example an option spelled `client` - instead of baking `clientEntry = undefined`
  into the server manifest and leaving every hydrating page to fail at request time. An empty string
  is still accepted for an app with no client script.
- 5934b5d: A generated Bun, Node or Deno server serves `public/` files and the client bundle with their content type, `x-content-type-options: nosniff` and a cache policy: immutable for the hashed `/assets/`, one day for the rest. A `robots.txt` or an `.svg` no longer arrives as a download, and the bundle no longer downloads again on every visit.
- 03a3729: fix: a generated `server-manifest.ts` type-checks under a strict tsconfig

  The manifest `generateServerManifest` and `nifra sync-manifest` write for a hand-written server entry
  now compiles under `strict` with `noUncheckedIndexedAccess`, including routes with a backend half or
  a typed `meta`. Its route table is typed as plain modules and handed to `buildManifest` as route
  modules, the same way `discoverRoutes` loads them.

- 579d9a9: A static boundary's `load` receives no `origin` when it runs during a request: its value is cached for every visitor, so it no longer takes the first request's `Host` header. A static load that fails is loaded again on the next request instead of serving the error until restart. `StaticBoundaryCache` gains an optional `delete`, which `MemoryStaticBoundaryCache` implements.
- 3554ad8: fix(web): a page the server rendered as a status page (`_404`, `_410`, ...) hydrates as that page,
  even when the URL also matches a route pattern, so a loader's `notFound()` stays a 404 in the browser.
  Routable `_`-prefixed directories such as `routes/_admin/` still hydrate as themselves.

  fix(web): build-vs-dev manifest parity passes for apps with `_`-prefixed routes. Both sides order
  route ids with the exported `compareRouteIds`, and a module-graph mismatch names what differs: the
  routes on one side only, each route's chunk counts, or the route order.

- ee19d29: fix(web): a Svelte app built with `buildClient` hydrates. `svelteDedupePlugin` pinned the bare
  `svelte` import to the entry the build process itself runs - Svelte's server runtime - so the
  browser bundle's `hydrate` threw and the server-rendered page never became interactive. For a
  browser bundle it now pins the app's one copy and reads that copy's export map with the bundle's own
  conditions, which selects the client runtime. A server bundle resolves as before.
- b94e5cb: A loader, action or boundary loader that throws a 2xx `Response` is refused exactly as returning one is: its body would reach the browser without passing the output schema. A thrown redirect or error status still answers the request.
- a84f546: fix(web): every pipeline names backend code that reaches the browser, however it is imported

  - A side-effect import of backend code (`import "../backend/x.ts"`) fails the Bun client build with
    the module and the import chain that reached it, even when the bundler drops the import.
  - A module marked backend-only fails the Vite client build even when it was inlined into no chunk.
  - The server build sees imports of modules the bundler later dropped.
  - The Vite dev server classifies what an alias, a tsconfig path or a package export resolves to, and
    names the importing file in the error.
  - `createViteDevServer(...).stop()` no longer hangs when it is called while Vite is still
    pre-bundling dependencies for the first time.

- 669b6a2: On Windows, the development guards and the build name files with `/` relative to the app, a Vite dev refusal shows its reason instead of a generic transform error, a pre-bundled dependency is judged by the source Vite built it from, and browser source maps resolve modules Vite serves from outside the root (`/@fs/`). A message about an emitted file names it relative to the app, and a `routes/` directory created after the dev server started holds routes whatever spelling the app root was given in.
- Updated dependencies [dde125b]
- Updated dependencies [72b62fa]
- Updated dependencies [aa44e93]
- Updated dependencies [4a3ee60]
- Updated dependencies [aad6297]
- Updated dependencies [dad0d41]
- Updated dependencies [538adc2]
- Updated dependencies [f47edd1]
- Updated dependencies [df9530a]
- Updated dependencies [3e6973f]
- Updated dependencies [25e8edf]
- Updated dependencies [2b5e5fc]
- Updated dependencies [3b090de]
- Updated dependencies [da7d792]
- Updated dependencies [612a296]
- Updated dependencies [fb14dfa]
- Updated dependencies [8ae97f6]
- Updated dependencies [4af6f39]
- Updated dependencies [ca8b50d]
- Updated dependencies [b00a889]
- Updated dependencies [b53d64f]
- Updated dependencies [66fd712]
- Updated dependencies [9c3d524]
- Updated dependencies [738e7a1]
- Updated dependencies [4801cac]
- Updated dependencies [1b2d53a]
- Updated dependencies [25fe13d]
- Updated dependencies [0852290]
- Updated dependencies [0589dbe]
- Updated dependencies [2e2d8c0]
- Updated dependencies [856f5ce]
- Updated dependencies [18aa5aa]
- Updated dependencies [cfd86b3]
- Updated dependencies [8ff96c9]
- Updated dependencies [4c46199]
- Updated dependencies [eef4932]
- Updated dependencies [6de8686]
- Updated dependencies [d7892ea]
- Updated dependencies [4936309]
- Updated dependencies [ff5a779]
- Updated dependencies [bbdc5a1]
- Updated dependencies [10bc446]
- Updated dependencies [e8270d9]
- Updated dependencies [ff4a062]
- Updated dependencies [43ba944]
- Updated dependencies [46c741a]
- Updated dependencies [7bfa25e]
- Updated dependencies [4936309]
- Updated dependencies [6e257a6]
- Updated dependencies [4a03d30]
- Updated dependencies [8e30090]
- Updated dependencies [28f3aaf]
- Updated dependencies [6d20355]
- Updated dependencies [6907cbe]
- Updated dependencies [b64c3ee]
- Updated dependencies [bda9637]
- Updated dependencies [81c720e]
- Updated dependencies [ed60b23]
- Updated dependencies [a158b74]
- Updated dependencies [ff25d68]
  - @nifrajs/core@4.0.0
  - @nifrajs/island-trigger@4.0.0

## 3.5.0

### Minor Changes

- ac27343: Add a per-request `nonce` resolver to `createWebApp`. Nonces flow through framework-owned document scripts, status pages, error pages, and 404s; nonce-bearing responses are marked `private, no-store` so request-specific CSP values are not replayed from caches.

### Patch Changes

- 6046984: Close fresh security and correctness gaps in table allowlists, ISR/cache behavior, streamed response capture, idempotency ownership, and canonical redirects.
- Updated dependencies [6046984]
- Updated dependencies [d5b7c22]
  - @nifrajs/core@3.5.0
  - @nifrajs/island-trigger@3.5.0

## 3.4.0

### Minor Changes

- Harden MCP error responses and browser-origin defaults, confine scaffold writes to `routes/`, and
  make sanitized HTML require an explicit sanitizer function.

### Patch Changes

- 8d23613: Add the opt-in `@nifrajs/webmcp` package: typed WebMCP registration, core-backed receipts, deterministic predictive-UI reconciliation, and host-independent conformance checks. Also tighten agent execution cancellation cleanup so aborted local work cannot leak into later turns.
- 8d23613: Add an opt-in Vite aggregate-CSS and deferred stylesheet-loading path that prevents lazy-route prefetch from attaching additional stylesheets before hydration.
- Updated dependencies [719d82e]
  - @nifrajs/core@3.4.0
  - @nifrajs/island-trigger@3.4.0

## 3.3.0

### Patch Changes

- @nifrajs/core@3.3.0
- @nifrajs/island-trigger@3.3.0

## 3.2.0

### Minor Changes

- 652201a: Make islands the first-class interactivity lane for zero-runtime vanilla pages. `@nifrajs/web/islands`
  now exports `defineIsland` to type an enhancer's props and `createIslandBus` for typed pub/sub between
  islands that share no state. `nifra check` gains `NF-C020`, warning when an island enhancer wires an
  event listener but returns no cleanup, and `nifra scaffold` emits a golden vanilla route stub. New
  "Islands" cookbook documents the counter, cart-badge, and filter patterns.
- 25305bb: Add `@nifrajs/web/nano`, the explicit-reactivity lane for small apps that want local state without a
  framework runtime. It exports `signal`, `computed(fn, [deps])` with an explicit dependency array,
  `resource(fetcher, [deps])` - an async cell with a `pending`/`error`/`ready` value union that aborts a
  superseded fetch and drops its stale result - and `bind` / `bindList` / `bindResource` DOM edges, all
  with no virtual DOM and no auto-tracking. Because every reactive edge is a visible call, `nifra check`
  gains three static lints: `NF-C021` (a `bind`/`bindList`/`bindResource` whose disposer is discarded),
  `NF-C022` (a `bindList` keyed by the array index), and `NF-C023` (a `computed`/`resource` that reads a
  signal its deps omit). `nifra scaffold` accepts `variant: "stateful"` to emit the golden nano island
  pattern on a vanilla project, and a new "nano" cookbook documents signals, keyed lists, async state,
  and where the lane stops.

### Patch Changes

- 3aefb12: Make the development/production stylesheet parity guard ignore generated output, comments, and documentation code examples while continuing to detect real stylesheet imports.
- c4ed8f7: Avoid quadratic regular-expression backtracking when rendering build instructions for separator-heavy output paths.
- c39712e: Move route policy compilation and deploy-target planning behind shared internal seams, pin the Solid adapter's Babel type identity, and add a cleanup-safe cross-runtime contract-lab runner.
- 7551709: Harden runtime boundaries and defaults: clean up subprocess abort listeners, support short Cloudflare
  KV sessions, bound and incrementally sweep the default memory cache, make image reads and cancellation
  safe, emit content-derived image validators, require trusted forwarded hosts, avoid caching dynamic SSR
  metadata, and reject invalid upload or image limits.
- Updated dependencies [8b58d1f]
- Updated dependencies [095c320]
- Updated dependencies [7504864]
- Updated dependencies [e88c23a]
- Updated dependencies [c39712e]
- Updated dependencies [9010fd3]
- Updated dependencies [ea2356e]
- Updated dependencies [a816b87]
  - @nifrajs/core@3.2.0
  - @nifrajs/island-trigger@3.2.0

## 3.1.0

### Patch Changes

- 8b136ee: Framework bindings now share consistent query and fetcher idle behavior while keeping mounted-router state isolated per adapter.
- a7db515: Frontend framework deduplication is now applied consistently across the Bun build, the Vite build, and the Vite dev server, so React, Preact, and Svelte each load a single copy in every client bundling path.
- Updated dependencies [5b78473]
- Updated dependencies [1400f6c]
- Updated dependencies [a7db515]
  - @nifrajs/core@3.1.0
  - @nifrajs/island-trigger@3.1.0

## 3.0.0

### Major Changes

- 004deee: `redirect()` returns a plain render instead of a `Response`.

  A redirect is a status line and one header - the most body-less response there is - and building a Web `Response` for it costs the whole object, plus a stream drained back out on Node. It is now the same plain-data value `status(...)` produces, rendered on the lane an ordinary return takes: same bytes on the wire, now with a `content-length` on Node rather than a chunked empty body.

  `redirect(...)` is still returned or thrown from exactly the same places - loader, action, layout gate - and `return redirect()` / `throw redirect()` stay interchangeable, including the client-submit conversion to a 204 + `X-Nifra-Redirect`.

  **Breaking:** the returned value is no longer a `Response`, so `.status`, `.headers`, and `instanceof Response` are gone from it.

  - Reading it: `redirect("/x").plain` is `{ status, headers, body }`. `toResponse()` builds the `Response` if something genuinely needs one.
  - Adding headers: pass them - `redirect("/x", { headers: { "cache-control": "no-store" } })`. Cookies are unaffected; they still ride `c.set` and apply to a redirect exactly as before.
  - Testing it: assert on `.plain` (or `toResponse()`), not on `.status`.

  The Node writer was framing a body-less response as chunked: `writeHead` followed by a bare `end()` leaves Node to pick the framing, so the shortest response the framework emits went out with a chunk terminator and no length, where every Web-native runtime sends `content-length: 0`. It now declares the zero length on both lanes - a plain render, and a hand-rolled `Response` whose body is `null`.

  A `Response` built from bytes - `new Response("hi")`, a `Uint8Array`, a `Blob` - now declares its length too. It hands those bytes over as a stream, exactly as a live producer does, so the writer could not tell the two apart and framed both as chunked. It now reads one chunk and gives the stream a microtask to say it is done: a source-backed body has already enqueued everything and closes inside it, a producer still generating does not. At most one chunk is held, never the whole body, so a large or endless stream is unaffected - and the microtask costs a streaming response no bytes on the wire, since Node does not flush the header until the first write either way.

  Excluded throughout: HEAD, whose length describes the GET's body that neither lane knows; a status that cannot carry a body; and a length the caller set for itself. A relayed upstream body is also left alone - its length is the upstream's business.

  A hand-rolled `Response` from a loader or action is untouched - still passed through verbatim, still converted the same way on a data request. Only what `redirect()` itself returns changed.

### Patch Changes

- 6e43c15: A failed boundary load no longer publishes the thrown error's own message. Boundary states are serialized into the document, so a driver or fetch failure was putting hosts, credentials, and query text on the page for every visitor who loaded it while the dependency was down. The client slot is now always `Boundary failed`, an `Error` subclass name is withheld for the same reason it names the failing internal library, and the real error is reported to the server console - the split already used for a rejected deferred value. A boundary that wants to show the user something specific catches its own failure inside `load` and returns that as data.

  Opt-in outbound WebSocket validation (`validateSend`) contains a rejected diagnostic instead of recursing. An `error()` handler that answers a dropped frame by sending one of its own re-entered the reporter through the two paths that bypassed its guard - schema rejection and an async validator - and unwound only when the stack was exhausted, silently. Every failure path now reports through the guard.

  A content index cursor is checked for the query that issued it separately from running off the end: a cursor from a different sort or filter is rejected at any position, and a matching cursor left past the last row by an index that shrank between pages returns an exhausted page rather than throwing.

- 293a7fe: Identity-parity findings now state the install topology, and `nifra doctor` and the build guard now answer on the same basis.

  Both tools already shared one walker, but they anchored it differently: doctor scanned the workspace that governs the project while the build guard scanned the app directory it was invoked in, so a duplicate that lives in a sibling workspace package could show up in one output and not the other. Since neither printed which directory it had scanned, that read as two tools contradicting each other about the same invariant. The scan is now always anchored on the governing workspace, both tools name the root they answered on, and a scan that stopped at the workspace-enumeration cap reports itself as partial instead of returning "no duplicates".

  A finding whose copies lie outside the directory the command was run in now says why it is still fatal there: the gate is workspace-wide deliberately, because a copy reached through a workspace-linked dependency is not visible from the app directory - the exact case that once had the check report "none" against an already-broken dev server. Running a build inside one app can therefore fail on a copy held by a sibling app, and the message states that trade rather than leaving it to look like the tool checking the wrong project.

  Each finding also carries a topology line: how many physical paths, how many install roots they fall under, and whether any of those roots sits outside the scanned root. That distinction is the whole fix decision - copies under one workspace collapse with a single reinstall from the root, while a copy under a linked checkout or a standalone sibling install belongs to another project and no reinstall here can remove it. Previously the error listed paths only, leaving that to be reverse-engineered.

  The hard gate now fails closed on a truncated scan. A scan that stopped at any of its caps - workspace packages, linked packages, or link probes - and then found no duplicates has not shown there is none; the duplicate can be sitting in the part it never reached. `assertIdentityParity` treats that state as inconclusive and throws, rather than reading an incomplete scan as a pass. The reporting surfaces (`nifra doctor`, the dev warning) still print the partial result and name the limit that was hit.

- 485ae60: `nifra build` no longer fails when a route imports a non-JS asset. The development/production manifest parity check compared a source-derived expectation against the build output; its module-graph section held every emitted asset, so any emitted non-JS file (an `import logo from "./logo.svg"`, a font) was a set difference no application could close. The module-graph contract is now the JavaScript module graph only - emitted assets are an output detail, served from source in development and hashed in production, with no dev/prod claim to compare.

  The stylesheet check is now directional instead of an equality. The development-side scanner is sound but incomplete by construction - it cannot see a dynamic `import()`, a `require()`, or a bare package `exports` subpath - so a production stylesheet the scanner missed passes, while the load-bearing direction (development found styles the build does not ship, so the page renders unstyled) still fails. The scanner also now recognizes `import(...)` and `require(...)` of a literal stylesheet path.

  `manifest.css` now means the same thing on both bundlers: the union of every emitted stylesheet, bootstrap aggregate first. The Bun pipeline previously kept only the aggregate, so a route-scoped stylesheet landed in `assets` but not `css` and normalized to a spurious asset difference.

  Parity failures now name the offending files - the production stylesheet URLs and the scanned source root for a css mismatch, the symmetric difference for a module-graph mismatch - and the identity-parity remediation is cause-specific: a version skew says reinstall, a duplicate path across a linked sibling repo says a reinstall will not collapse it and one tree must resolve into the other.

- 627b0ba: Duplicate-install detection (`NF-C009` / `NF-D001`) no longer sweeps an unrelated sibling repository.

  A dependency symlinked into another project's package store (bun's `node_modules/.bun/<pkg>@<version>`, an `npm link` target, a shared global store) was treated as a linked source checkout, so the scan walked up to that project's `.git` and reported its whole dependency tree as duplicates of the project being checked - findings in a repo the developer is not working in, that no change in their own project could ever clear. A linked root that resolves inside a `node_modules` directory is now clamped to itself: only its own nested `node_modules` is scanned, which is exactly the set of modules it can load. The store copy itself is still reported, because it is genuinely what the project resolves; a real linked source checkout (`link:../../pkg`) still has its whole repo scanned, because its imports really do resolve there.

- f0fd370: The same-origin check behind `redirect()` and the guards' `redirectTo` now rejects the paths a URL parser resolves onto another origin, and lives in one place.

  A leading `/` that is not `//` is not sufficient to keep a destination on this origin. Under a special scheme a backslash parses as a path separator, and tab, CR and LF are stripped from the input before parsing, so `/\evil.example` and `/<TAB>/evil.example` both pass a `//` test and then resolve to the host `evil.example` - an open redirect reachable from any unvalidated `?next=` parameter. Both forms are now refused: `redirect()` throws as it already did for `//host`, and an auth guard falls back to its configured destination instead of honouring the value.

  New export `isSameOriginPath` from `@nifrajs/core/server`, which is the single implementation the three gates now share - a security predicate kept in three copies is three chances for one of them to be hardened alone. It answers about a path, so an absolute URL is false even when it names the current origin: the point of the gate is that the value never got to name a host at all.

  A percent-encoded backslash (`/%5Cevil.example`) is still a same-origin path, because that is what it resolves to.

- 36801ae: New: a static `singleCopy` declaration that collapses an identity-sensitive package to one physical copy, for the duplicate no install can remove.

  An app that consumes a package by `link:` from a **separate checkout** cannot deduplicate React (or `@nifrajs/*`) by installing differently. The linked files live in the other repo, so their imports resolve from that repo's real path, and that repo's install owns its `node_modules`: peer dependencies are already satisfied there, `overrides` govern the consuming install only, and a deleted nested copy returns on the sibling's next install. The build's existing per-framework dedupe covers bundled output, but nothing covered `bun test`, `bun run`, or a preloaded script - and `nifra check` failed the app with remediation ("deduplicate the install") that the topology makes impossible.

  An app now declares the packages in its own `package.json`:

  ```json
  { "nifra": { "singleCopy": ["react", "react-dom", "@nifrajs/*"] } }
  ```

  Entries are exact names or `@scope/*` patterns; `true` expands to the built-in identity-sensitive set (`@nifrajs/*`, `react`, `react-dom`, `preact`, `solid-js`, `svelte`, `vue`). `@nifrajs/*` is in that set because two copies of `@nifrajs/core` are two distinct `Server` classes, so `.merge()` stops accepting an app built against the other one. The declaration is static so `nifra check` can read it without importing the app's config, which would mean executing app code inside a preflight.

  `buildClient` and `buildServer` inject the resolver from the declaration, so bundled output needs no wiring. Unbundled phases are not covered automatically - Bun's runtime resolver never offers a bare specifier to a plugin - so an app preloads `@nifrajs/core/single-copy/register` from `bunfig.toml` (`preload` for `bun run`, `[test].preload` for `bun test`). `nifra check` now names the phase that is left uncovered when the declaration exists without the preload.

  The redirect refuses to cross versions: two copies at different versions are skipped as `version-skew` and stay fatal, because collapsing them would turn a loud install problem into a quiet behavioural one. A declared duplicate is reported, not suppressed - `nifra check` keeps printing the copies as a warning and `nifra doctor` lists them under `deduplicatedInstalls` - so the topology stays visible without failing the gate.

  New exports: `@nifrajs/core/single-copy` (`singleCopyPlugin`, `registerSingleCopy`, `planSingleCopy`, `readSingleCopyDeclaration`, `readSingleCopyRegistration`, `matchesSingleCopyDeclaration`, `IDENTITY_SENSITIVE_PACKAGES`) and the side-effect entry `@nifrajs/core/single-copy/register`.

  The registration proof reads `preload` as entries rather than as text: an entry counts only when it **is** the register specifier, not when it merely contains it. A neighbouring path such as `"./vendor/@nifrajs/core/single-copy/register-shim.ts"` used to satisfy the check while Bun loaded that other module and the registrar never ran, so enforcement was reported as armed on a process still loading both copies. A `preload` this cannot read as quoted entries - a multi-line array, an interpolated value - now reports "not registered" instead of standing in for proof.

- Updated dependencies [f3d2a35]
- Updated dependencies [6e43c15]
- Updated dependencies [f0fd370]
- Updated dependencies [86a555b]
- Updated dependencies [8c5f4cf]
- Updated dependencies [f0fd370]
- Updated dependencies [381bbf3]
- Updated dependencies [36801ae]
- Updated dependencies [9acadba]
- Updated dependencies [99fc683]
- Updated dependencies [73d894d]
  - @nifrajs/core@3.0.0
  - @nifrajs/island-trigger@3.0.0

## 2.14.1

### Patch Changes

- Updated dependencies [bf93902]
  - @nifrajs/core@2.14.1

## 2.14.0

### Minor Changes

- 489c6b6: `nifra dev` gains `--allow-duplicate-identity`, which downgrades the Vite dev server's startup
  identity-parity check from a hard failure to a loud warning. The check catches two physical copies of
  an identity-sensitive package (React, the framework adapter, `@nifrajs/core`) resolving in one process,
  which reliably breaks hydration and framework context - so it stays a hard stop by default, and
  `nifra build` never honors the flag. But when the duplicate originates in a linked sibling repo you
  cannot fix in the moment, the previous behavior took the dev server down with no way to keep working.
  With the flag, the server prints the same finding detail (packages, versions, resolved paths) and a
  reminder that duplicate identity can still corrupt hydration, then continues at exit 0. The web option
  `createViteDevServer({ allowDuplicateIdentity: true })` exposes the same escape programmatically.

### Patch Changes

- 62e22e2: The generated `server-manifest.ts` now imports each route module by an extensionless specifier, so a
  plain `tsc` over the project compiles it without `allowImportingTsExtensions`. Previously the manifest
  emitted `.tsx`/`.ts` import paths that only `nifra check` (which sets that flag) accepted, and a bare
  `tsc` reported TS5097 for every route. Route identity is unchanged: the manifest map keys still carry
  the original file path with its extension.

  Manifest drift detection (`nifra check`, `nifra sync-manifest`) now reads those extension-bearing map
  keys rather than the import specifiers, so it keeps matching the discovered `routes/` tree exactly and
  does not false-report every route as drifted against the extensionless specifiers.

- 62e22e2: `nifra sync-manifest` now preserves a lazy manifest's shape instead of silently rewriting it as eager.
  The re-sync detected the lazy (`() => import(...)` per route) vs eager (`import * as`) form by looking
  for `const loaders =` in the source, but the generated declaration is `const loaders: Record<...> = {` -
  the type annotation sits between the name and the `=`, so the check never matched and every lazy
  manifest came back eager, collapsing per-route code splitting into a single boot-time bundle. Detection
  now anchors on the `const loaders` declaration itself, so a route-table refresh keeps the app's chunking
  exactly as committed.
- 8dffdf4: `.use(plugin)` no longer silently collapses the app's typed route registry to `any` when a plugin's own
  types are unpinned. A plugin whose parameter and return infer as `Server<any, any>` - an auth or router
  plugin that widened - now makes `.use()` return the non-callable `PluginTypeCollapsed` marker at the
  call site, rather than an `any` that only surfaces hundreds of lines away as `never`/`any` in the typed
  client. Build the plugin with `defineIdentityPlugin`/`defineContextPlugin`, or pin its input server
  type, and it threads the caller's registry and context unchanged.

  `serverFunctions()` now ships as such an identity plugin, so `app.use(serverFunctions(...))` keeps every
  route declared before and after it fully typed.

- 489c6b6: The Vite dev pipeline no longer serves a stale SSR module after an edit to a file a route imports. Vite
  re-evaluates a directly-changed module on its own, but a parent that merely imports the changed leaf
  kept its cached SSR bindings, so the re-created app walked a graph that was fresh at the leaf and stale
  above it. That surfaced as phantom hydration mismatches (SSR rendered through an old module, the client
  through the new one) and stale i18n catalogs. On every change the dev server now evicts the changed file
  together with its transitive importer closure from the SSR graph before rebuilding the app, so the next
  render re-walks the whole affected subtree. Apps whose only transforms are `vitePlugins` (and are
  therefore forced onto the Vite pipeline) get correct hot reloads without a manual restart.
- Updated dependencies [701961a]
- Updated dependencies [62133bf]
- Updated dependencies [8dffdf4]
  - @nifrajs/core@2.14.0

## 2.13.0

### Minor Changes

- 6510fdc: Fail a build or dev-server start when identity-sensitive packages (the framework runtime, React,
  Preact, Svelte, Solid, Vue) resolve to more than one physical copy, or when the development and
  production manifests diverge in routes, public files, or styles. Single-file-component `<style>`
  blocks count as styles, so a scoped-style Svelte or Vue component is not reported as diverging from a
  production manifest that carries its extracted stylesheet.

### Patch Changes

- e0b2dd6: Harden three regex-adjacent input paths against pathological input. The byte-range parser bounds an
  oversized `Range` header before the matcher runs rather than after; the problem-details type builder
  strips trailing slashes with a linear scan instead of a backtracking pattern; and the dev SSR
  import-graph specifier pattern no longer has an ambiguous whitespace group. Behavior is unchanged for
  valid input.
- Updated dependencies [e0b2dd6]
- Updated dependencies [7535ce1]
- Updated dependencies [1704308]
  - @nifrajs/core@2.13.0

## 2.12.1

### Patch Changes

- Updated dependencies [fba30c7]
  - @nifrajs/core@2.12.1

## 2.12.0

### Minor Changes

- 4c2123d: `navigate()` accepts a `state` option: opaque, structured-cloneable per-entry state stored on the
  history entry it creates, in both the string and object call forms. It is written under
  `history.state.nifraState` so it can never collide with the router's own bookkeeping keys
  (`nifraIndex`/`nifraScroll`), read back as `history.state.nifraState`, and restored by the browser on
  back/forward at no cost. History-delta navigations (`navigate(-1)`) ignore it.
- c55f7a3: `/llms.txt` and `/llms-full.txt` no longer publish the project's `AGENTS.md`. Those endpoints are
  public and unauthenticated, while `AGENTS.md` is a repo file written for the team - unreleased feature
  names, internal hostnames, and "don't touch X yet" notes live in it routinely, and every app that
  happened to have one was serving it to anyone who asked. Set `publishLocalGuidelines: true` on
  `createWebApp` to restore the old behaviour for a repo whose guidelines you would publish as a page.
  Everything else in both endpoints (routes, pages, client-call examples) is unchanged.

### Patch Changes

- fa51aba: Restore the dev-phase environment flags a programmatically started dev server sets when it stops, so a later in-process consumer sharing the process does not read them as if a dev server were still running.
- 33ee9ff: `loadGoogleFont` emits a variable weight range in the dotted form the fonts endpoint expects. A
  range spelled CSS-style (`"100 900"`) was passed through with its literal space, which the endpoint
  answers with a `400`; both spellings are accepted now and normalized to `"100..900"`. A reversed or
  degenerate range (min not less than max) throws at the call site instead of producing a request that
  fails at load time.
- 0863ef0: `withISR` no longer serves a cached page to a soft-navigation data request. Cache entries are full
  HTML documents keyed by URL, so a client-side navigation's loader fetch (`x-nifra-data`) could
  receive a document where it expects a loader payload. Those GETs now bypass the cache entirely,
  matching the write path, which already refused to store data-mode responses.
- 24f1787: Align Vite production CSS Module scoped names with the Bun pipeline and the Vite development server so switching pipelines preserves the class-name map.
- df07059: `redirect()` (and any `Response` control-flow signal) now behaves identically whether a loader or action returns it or throws it. A loader that RETURNS `redirect(...)` passes the response through to the client verbatim instead of serializing the `Response` object as loader data; a returned status signal renders its boundary exactly like a thrown one. An action (or a layout gate on the mutation path) that THROWS `redirect(...)` gets the same treatment as a returned one: a client submit receives the `X-Nifra-Redirect` header on a 204 and navigates, a native form POST receives the 3xx.
- a5d3f5b: Add stable diagnostic codes, application-supplied rule packs, fix recipes, assurance bundles, contract lock snapshots, hydration assurance hooks, replay metadata, security verification rules, and idempotency proofs.
- 64d25db: Deferred-data reconstruction stores every key with `Object.defineProperty`, on the server walk and in
  the injected client mapper alike. A `__proto__` key in serialized data previously went through plain
  assignment, which walks the inherited setter instead of storing data - so the key silently vanished
  from the reconstructed object, and on the client it reached a prototype setter with attacker-shaped
  data. The result is still a plain `{}` with `Object.prototype` intact, so `toString`, `hasOwnProperty`
  and `constructor` keep working on the value the app receives.
- Updated dependencies [df100d3]
- Updated dependencies [0efacea]
- Updated dependencies [cd1732c]
- Updated dependencies [df100d3]
- Updated dependencies [9a9346e]
- Updated dependencies [b5f47c0]
- Updated dependencies [fc33c0f]
- Updated dependencies [c4e8bb0]
- Updated dependencies [11d1658]
- Updated dependencies [5f71c23]
- Updated dependencies [3788b36]
- Updated dependencies [ae5338f]
- Updated dependencies [8847825]
- Updated dependencies [9a9346e]
- Updated dependencies [5e4e31a]
- Updated dependencies [9a9346e]
- Updated dependencies [b045f9e]
- Updated dependencies [9a9346e]
- Updated dependencies [9a9346e]
- Updated dependencies [dbc0b79]
- Updated dependencies [bd5c624]
- Updated dependencies [a5d3f5b]
- Updated dependencies [00819c5]
- Updated dependencies [e2bdd4a]
- Updated dependencies [e2d1939]
- Updated dependencies [e83e6eb]
- Updated dependencies [f8b0097]
  - @nifrajs/core@2.12.0

## 2.11.0

### Minor Changes

- ed5e91c: Vue, Solid and Svelte hot-patch a component edit in place on the Bun dev pipeline: the page keeps its scroll position, its open dialogs and the rest of its client state, and only the edited component re-renders. Route modules still full-reload on save, since a route carries the loader and meta the server ran. The wiring is emitted for a dev server's client compile only, so nothing reaches a production bundle.

  `@nifrajs/web-svelte/plugin` adds `svelteHmrBoundary`, the same boundary for the Vite pipeline - pass it to `@sveltejs/vite-plugin-svelte` as `dynamicCompileOptions`. Svelte's hot-patch wrapper resolves a component through a signal, which reconciles against server markup only where the component is a plain child in a template; a layout or a page is neither, and wrapping one desyncs hydration on first load. The boundary keeps the wrapper on the app's own views. (Svelte recreates the patched component, so its own `$state` restarts - Vue and Solid preserve theirs.)

  `Router.svelte` now takes `searchOfChain` from `@nifrajs/web/client` rather than the package root, so a client bundle no longer reaches server-only modules through it.

- 30f5ea3: SSR renders the code that is on disk on the Bun dev pipeline, not just for route files. An edit to anything a route imports - a component, a helper, a `*.server` module, at any depth - now reaches the server-rendered HTML on the next request, so a saved change no longer shows up on the client while the SSR pass still renders the version the server started with. All four frameworks, and both `import "./Counter"` and `import "./Counter.tsx"`.

  A module nobody edited keeps its identity, so a database client or any other module-scope singleton shared between the backend and a route is still a single instance; editing that module deliberately gives the routes the new code. The Vite pipeline is unchanged - it already owned an SSR module graph.

  `@nifrajs/web/plugins/kit` adds `rewriteSsrImports`, which a plugin that compiles its own file type passes its `generate: "ssr"` output through - the compiling plugin is the only code that sees that file's imports, so it is the only place they can be re-keyed.

- c29e0d0: Svelte runs on the Vite pipeline. `nifra dev` and `nifra build` now serve and build a Svelte app on either bundler, so a Svelte app is no longer the one framework pinned to a single pipeline, and pages render with routing context, typed search and layout data intact on both.

  `@nifrajs/web` adds `setSsrModuleLoader` / `ssrModuleLoader`, the seam that makes it work. A dev server that owns SSR resolution publishes its module loader; a render adapter that has to load a compiled asset on the server reads it and loads through it, so that asset is compiled by the same toolchain as the app's routes and renders through the same copy of the framework runtime. Adapters that ship no compiled assets are unaffected.

  `conditions` on the Bun dev pipeline reaches SSR, and says so when it cannot reach the client bundle Bun's dev server serves - a one-line startup notice instead of a package that quietly resolves to one file in dev and another in `nifra build`.

  CSS Modules class names are now identical on both pipelines. The same class hashes to the same scoped name under `nifra dev`, `nifra dev --bun` and `nifra build`, so a selector written against a generated name behaves the same everywhere.

  The dev-and-HMR guide gains a Gotchas section covering the config/adapter file split, plugin slots, resolve conditions, non-route SSR freshness, and the adapter loader.

### Patch Changes

- @nifrajs/core@2.11.0

## 2.10.0

### Minor Changes

- 5263c4e: `KVCacheStore` accepts a `minExpirationTtl`. The 60-second floor is Cloudflare KV's, and it stays the default, but `KVNamespaceLike` is three structural methods that Redis, Deno KV and Upstash satisfy too - and those accept far shorter TTLs. Declare the binding's real minimum, or `0` for a backend without one. A non-integer or negative TTL is now rejected at construction rather than reaching the binding.
- 15bffdd: Serve `public/` with byte ranges. Static files now advertise `accept-ranges`, answer a single-range request with `206` and `content-range`, return `416` for an unsatisfiable range, and publish `last-modified` with `if-modified-since` and `if-range` handling. HEAD reports the same `content-type` and length metadata GET does. `parseByteRange` moves to `@nifrajs/core/range` so the static handler and `@nifrajs/middleware`'s `rangeResponse` share one parser; the middleware export is unchanged.
- 15bffdd: Add request-bound data capability evidence, resumable bounded channel subscriptions, ISR tag
  invalidation for memory and KV stores, and dependency-free Open Graph image responses with an
  optional rasterizer seam.

### Patch Changes

- Updated dependencies [15bffdd]
- Updated dependencies [15bffdd]
- Updated dependencies [15bffdd]
  - @nifrajs/core@2.10.0

## 2.9.1

### Patch Changes

- Updated dependencies [01e36fb]
  - @nifrajs/core@2.9.1

## 2.9.0

### Patch Changes

- e05e56d: Improve hot paths across runtimes and the browser: a validated-POST fused lane for Bun/Deno Web
  requests (measured +12.7% Deno, +3.5% Bun on `POST /users`) plus a registration-compiled body
  validation/handler continuation shared by Web and Node-direct (about 9.6% faster than the generic
  body lane in-process), client route matching indexed on the core router instead of a linear scan
  (measured ~18x faster on a 100-route app), search-param parsing in one pass instead of O(keys²), and
  allocation-free fast paths for static asset URLs and safe SSR script serialization.
  Bare fused-lane Web requests with no active timeout or deadline now run on the lazy request
  context (the one the Node direct path already uses), with the platform - `c.env`, `c.clientIp`,
  `c.waitUntil` - carried through and `c.signal`/`c.budget`/`c.query` resolving lazily to identical
  values, pinned by a regression test. Measured +4.5% on a bare `GET /users/:id` on Deno. Routing
  also stops allocating a `{ pathname, search }` pair per request on the portable path.
  Node serving now keeps synchronous Web request middleware on the direct renderer, adapts in-place Web
  response middleware back to direct buffered writes, and avoids redundant params/body lifecycle stages
  for common validated reads. Header-only built-ins (`cache-control`, `powered-by`, and related response
  mutators) no longer clone buffered responses on Node.
  New portable middleware hook: `onResponseBody(body, headers, req, status)` - the post-serialization
  payload tier. The hook receives the FINAL framework-serialized bytes plus the mutable header view,
  and may return replacement bytes. On the Node direct writer the bytes come straight off the outcome
  record; on the Web serving paths they ride the framework-built Response as an inert tag (attached
  only once a body hook is registered), so no body stream is ever drained on any runtime. A
  handler-returned raw `Response` (a proxied fetch, SSE, a streamed page) is skipped by contract, a
  structured return (`{ body, status }`) can drop the body or change the status (an ETag `304`), and
  transforming those remains `onResponse`'s job. A body-observing middleware written this way
  measures at ~92% of a raw `node:http` server on the realistic route, vs ~50% through the full
  `onResponse` contract.
  New middleware hook: `onResponseRaw(response, req)` - the raw-response tier. It runs ONLY for
  responses the payload tier skips (streams, proxied fetches, and framework-generated error
  responses); a framework-serialized JSON body stays on `onResponseBody` and, on Node, on the direct
  socket writer (the raw hook self-pairs with a no-op native twin, so registering one does not force
  the fallback path). Together the two tiers cover every response without double-processing any.
  Response-body tagging is now scoped per app instance instead of process-wide: one app registering a
  body hook no longer makes unrelated apps in the same process pay for tagging, `merge()` keeps the
  tag readable across merged apps, and a foreign Response carrying a look-alike marker is not treated
  as a framework-serialized body.
  Bodiless statuses are normalized on every render path: a handler returning a `204`/`205`/`304` (or
  a body hook converting to one, e.g. an ETag `304`) always ships with no body and no
  `content-length`, on the Web paths and the Node direct writer alike.
  Response-header records are built null-prototyped everywhere user-influenced names can land in
  them, so header names like `__proto__` stay data instead of touching the record's prototype; the
  header view over Node outcomes also resolves names via a one-time per-request index instead of
  scanning the record on every get/set (measured at roughly a fifth of the framework's own CPU on a
  realistic middleware-carrying route).
  Guarded response headers (a raw `fetch()`ed Response) are now detected with a reversible probe
  before any header hook runs, instead of catching the mutation `TypeError` and re-running the hook
  against a clone - a hook that itself throws `TypeError` no longer runs twice. Framework-constructed
  responses stamp their headers as known-mutable at construction, so the hot path answers that
  question with a single weak-set lookup and only a handler-returned foreign `Response` ever pays the
  probe, once per headers object.
  New portable middleware hook: `onResponseHeaders(headers, req, status)` - the recommended shape for
  response middleware that only reads or writes headers. One implementation runs on every runtime: on
  the Web serving paths it mutates the response's own `Headers` inside the normal response walk (no
  clone), and on Node it self-pairs as a native hook against the outcome record, so registering one
  never forces the Node adapter off its direct socket writer the way a full `onResponse(res:
Response)` hook does.
  Native Node hook lanes now engage as a unit - the response-side native hooks run only when the
  request side is native too - which makes the native request context's identity stable across a
  request; the context also carries `url`, and both are documented so middleware twins can key
  per-request state on it. Building a Web `Request` from a Node request fills its header list once
  from a plain record instead of copying a prebuilt `Headers` a second time.
  Query and cookie parsing intern repeated key names on V8-based runtimes (Node, Deno) through a small
  bounded cache - V8 pays ~13x to store a freshly-sliced string key on the null-prototype records the
  parsers build, so handing back the first-seen key makes the store take the fast path. High-cardinality
  or oversized keys bypass the cache and behave exactly as before, and JSC (Bun) skips the scheme
  entirely (it has no such cost).
  When any route registers `onResponseBody`, every JSON response with caller-set headers (the common
  shape once a route has middleware) stopped pre-building a throwaway `Headers` instance just to
  check for an existing `content-type` - that instance was immediately handed to `new Response()`,
  which does its own header ingestion regardless, so the pre-build was pure waste. The check now runs
  against whatever shape the headers already are (a plain record gets a shallow copy only when
  `content-type` is absent; an already-built `Headers` is mutated in place, as before) and that result
  goes straight into the `Response` constructor. Deno/V8 charged far more for the discarded `Headers`
  instance than Bun/JSC did - measured previously as the entire gap between the payload tier's Deno
  row and its own raw ceiling on the realistic-shape benchmark; that row now leads every peer
  framework and sits within a few percent of raw `Deno.serve` again.
  On Deno, JSON responses that carry caller-set headers are now built as a bare `Response` whose
  headers are set individually afterwards, instead of handing the header record to the constructor -
  Deno charges far more to ingest a header-record init than to mutate a built response's `Headers`.
  The runtime's own `Response.json` content-type is probed once and reused, so the wire contract is
  exactly what `Response.json` ships on that runtime, and Bun keeps the constructor path it measures
  faster on. Measured +7% on the realistic middleware GET row and +12.7% on its body-hash variant;
  with this, the realistic Deno rows lead the closest peer framework on both GET and POST.
  The native header view's one-time name index is now authoritative for every operation, including
  writes of names not yet present: setting a new header no longer walks and lowercases the whole
  record on the way in, which had made each fresh `set()` cost grow with the headers already written
  (measured +2.2% end to end on the realistic middleware-carrying Node GET row). Case-insensitive
  reads still cover the record as first seen plus everything written through the view; a native twin
  writing the record directly uses lowercase names - the wire form the record documents.
  New response tier: `app.responseHeaders(record)` (and `responseHeaders` on a middleware bundle) for
  response headers with no per-request decision behind them. Declaring them registers no response hook,
  so the values fold into response construction - one prebuilt init for JSON renders, one record merge
  where the request set its own headers - and an app whose response middleware is only static keeps the
  lanes a hook closes: Bun's fused native routes, and the Node direct socket writer that a full
  `onResponse` gives up. They still apply to every response a hook would cover (success, error,
  404/405, timeout, short-circuit), byte-identically to registering the same names as an
  `onResponseHeaders` hook, on every runtime - pinned by parity suites over `app.fetch`, the Node
  adapter's own socket writes, and the Deno serve path. Declared headers are DEFAULTS: a value the
  request produced (`c.set.headers`, or a response hook) wins, whatever casing it used, and one name
  spelled two ways still ships as one header line. Names are lowercased once at wire-up; a non-string
  value, an invalid name, `__proto__`, or a name the render owns (`content-type`, `content-length`,
  `transfer-encoding`, `set-cookie`) throws a `TypeError` there instead of surfacing on the wire.
  Declarations made before any response hook merge into one record; one made after a hook registers as
  an ordinary header hook so registration order is preserved.
  `securityHeaders()` and `poweredBy()` (in its default respect-existing configuration) now declare
  their headers instead of writing them from a hook: measured +11% on a bare Bun `GET` behind
  `securityHeaders()`, within noise on Node and Deno (where the per-response header writes, not the
  response walk, dominate). Middleware whose headers depend on the request keeps the hook - `cors`
  reflects an origin, and `cacheControl` gates on method and status.
- Updated dependencies [e05e56d]
  - @nifrajs/core@2.9.0

## 2.8.2

### Patch Changes

- f7d68e8: Numeric limit options (body/payload byte caps, TTLs, cache sizes, concurrency, ISR revalidate windows) are now validated at construction and throw a `RangeError` on non-finite or out-of-range values instead of silently disabling the bound - a `NaN` cap previously made `size > max` comparisons fail open. JWT `requiredClaims` now checks own properties only, so inherited names like `toString` no longer satisfy a required claim. `@nifrajs/mcp-db` gates multi-statement input with a real tokenizer, bounds `run_query` materialization to `maxRows + 1` via a wrapping subquery, and skips SQLite planner pseudo-nodes when verifying the table allowlist. `nifra scaffold` refuses to write through symlinked route directories.
- Updated dependencies [f7d68e8]
  - @nifrajs/core@2.8.2

## 2.8.1

### Patch Changes

- Updated dependencies [78d66a4]
- Updated dependencies [93fdc89]
  - @nifrajs/core@2.8.1

## 2.8.0

### Patch Changes

- 118e4a5: `nifra dev --bun` now supports server functions and `*.server` modules. Bun's dev-server bundler accepts plugins only through bunfig's `[serve.static]` channel, so the CLI generates a config under `.nifra/dev-bun/` carrying the same production boundary plugins (server-fn RPC stubs, server-only emptying), merges the app's own bunfig `[serve.static] plugins` and `preload` entries, and re-launches itself once with `--config=` pointing at it - identical stubs across dev and build, and the old fail-closed refusal for those modules is gone. The relaunch is verified with a per-launch random token (matched against a file the parent just wrote, consumed on first read, constant-time compare), so no fixed environment value can make the server skip the boundary configuration; an unverifiable launch regenerates and re-launches instead of serving. The app's entire bunfig is carried into the generated config verbatim - jsx, defines, loaders, install settings - with path-bearing entries re-rooted; a bunfig field the generator cannot round-trip, or malformed TOML, fails loudly instead of being dropped. CSS Modules remain gated under `--bun`.

  Also fixed in `@nifrajs/web`: `serverFn<Input, Output>(...)` with explicit type arguments is now recognized by the client-boundary scanner - it previously produced an exportless stub that failed the client build with a missing-export link error (a type argument containing parentheses still fails loudly with guidance, never silently). The dev loop's background leak guard now reports the underlying bundler errors instead of a bare "Bundle failed".

  - @nifrajs/core@2.8.0

## 2.7.1

### Patch Changes

- Updated dependencies [52c89e0]
  - @nifrajs/core@2.7.1

## 2.7.0

### Patch Changes

- @nifrajs/core@2.7.0

## 2.6.1

### Patch Changes

- 80419f5: Non-hydrated pages (`hydrate: false`) omit the adapter's hydration bootstrap from `<head>` - with no client takeover, scripts like Solid's hydration registry were dead bytes on a static document. The Preact adapter's `renderToString` also returns synchronously once its renderer module is loaded (first call still resolves it lazily), so buffered renders take the synchronous fast path on every subsequent request.
- Updated dependencies [5840c98]
  - @nifrajs/core@2.6.1

## 2.6.0

### Minor Changes

- 08fe221: Per-route document-assembly caching for SSR. `renderPageResult` accepts an `assemblyCache` slot (new `RenderAssemblyCache` type): the request-invariant document pieces - the head (title, meta tags, style links, module preloads, hydration head) and the tail statics - are built once per route and reused, while per-request values (loader data, params, deferred state, action and layout globals) are always assembled fresh. `createWebApp` wires a slot automatically for every route whose meta chain is static (a `meta(data)` function keeps that route on fresh assembly), invalidating on module identity change so dev HMR stays correct, and a per-request CSP nonce bypasses the cache entirely. Output is byte-identical; on a realistic page (meta set + stylesheets + route chunks + an island) the render+assembly step is ~21% faster, which measures as roughly 10-15% more requests per second on the Node SSR path.

### Patch Changes

- e6349e5: Security hardening across input parsing and code generation. Every regex that runs on caller-influenced input (URL paths, route patterns, stylesheet and SVG sources, manifest text) is now linear - no polynomial backtracking on adversarial input. SVG preamble stripping and tag removal can no longer splice removed delimiters into new markers. Static file serving rejects `..` traversal in the request form outright and confines the resolved path with a `relative()` containment check. Generated code embeds strings through an escaper that neutralizes `</script>` breakout and the U+2028/U+2029 line separators, and HTML entity decoding resolves `&amp;` last so double-encoded entities cannot double-unescape.
- 8383063: The SSR render fast path does less work per request, with byte-identical output. The hydration-head nonce rewrite is skipped when no CSP nonce is set - it was a `.replace` over the whole (constant) hydration script that produced identical output on the common no-nonce path - and the combined deferred-list is reused instead of re-spread into a fresh array on the common page-only render (no layout loader, no action).
- Updated dependencies [e6349e5]
  - @nifrajs/core@2.6.0

## 2.5.0

### Patch Changes

- 02d9aa8: Routing hooks now SSR-render correctly on the dev server. In dev, the adapter is imported by Bun while route modules load through Vite's SSR runner, so the router module could be evaluated twice in one process - two context objects, and `useSearch`/`useParams`/`useLocation` read a context the render never provided. The result was hooks SSR-rendering their empty defaults (`useSearch()` gave `{}`) while the same request's loader saw the validated values; hydration then papered over it on the client, so it surfaced as "the search schema doesn't work in dev". The router context in every adapter is now a `globalThis` singleton (keyed by `Symbol.for`), so both evaluations share the one context React/Vue/Solid/Preact matches providers to readers by. The Vite dev server also mirrors its client `resolve.conditions` into `ssr.resolve.{conditions,externalConditions}`, so dev SSR resolves the same `bun`-conditioned source files Bun does instead of a package's `dist` artifact - which nothing in the dev loop rebuilds, and whose staleness previously 500'd inside framework code.
  - @nifrajs/core@2.5.0

## 2.4.0

### Minor Changes

- 23e6eb1: Errors resolve to a structured diagnostic - one object a person reads in the overlay and an agent reads as JSON.

  The dev error overlay now shows a source codeframe around the offending line and, for failures nifra recognises (a server-only module or a `node:` built-in reaching the client, a schema mismatch), a plain-language cause and fix with a docs anchor. A new `@nifrajs/web/diagnostic` export builds that `Diagnostic` - stable `code`, the top frame in your own source, the codeframe, and the cause/fix - from any thrown value, and the dev server serves the most recent one as JSON at `/__nifra/last-error`.

  `nifra_explain` (MCP) turns an error - pasted from `nifra_run`/`nifra_test` output, or the dev server's last - into that same diagnostic, so an agent gets the code, the codeframe in your source, and the fix instead of eyeballing a stack trace.

### Patch Changes

- 1c2bf5a: Harden the dev-only diagnostics endpoint and the agent-facing reads of it. The dev server now binds to `127.0.0.1`, answers `/__nifra/last-error` with an identity header, and resolves source paths so the codeframe stays inside the project. The Vite dev server serves that endpoint at parity with the Bun one. `nifra_explain` and `nifra_inspect` validate the target port, time out, cap the response size, and only return a body from a verified nifra endpoint - so pointing them at an unrelated local service returns a clear error instead of that service's response.
- Updated dependencies [138bfba]
  - @nifrajs/core@2.4.0

## 2.3.0

### Minor Changes

- ea0a27f: `head.script` carries data; executable code goes through a named escape hatch with a CSP nonce.

  ```ts
  head: {
    script: [{ content: JSON.stringify(article) }],          // application/ld+json or application/json
    unsafeScript: [unsafeInlineScript("window.dataLayer = []", { nonce })],
  }
  ```

  **Breaking**, deliberately. The slot used to take any `type`, including `module`. Its escaping guards
  against closing the element early - `</script>`, `<!--`, `]]>` - which is exactly what inert JSON needs
  and is no protection whatsoever for code. A route interpolating loader data into an executable body
  therefore had escaping that looked like a boundary and was not one. The slot now accepts only what it
  can actually make safe: a wrong `type` is a compile error, and it throws at render for callers the
  types do not reach.

  `unsafeInlineScript()` is the replacement, named after what it is and requiring a nonce. Pass the same
  nonce to `renderPage` and it reaches every framework-owned script in the document - the hydration
  bootstrap, the pre-hydration guard, the data script, streamed deferred resolutions, island tags, and an
  adapter's own hydration head - so a strict `script-src 'nonce-…'` policy becomes achievable rather than
  aspirational. A render without a nonce emits exactly the bytes it did before.

  Both `type` fields are allowlists rather than escaped values, checked in one place for the server
  render and the client soft-navigation together: a head that renders and then throws on the next
  navigation is worse than one that never rendered.

- 45b0733: `nifra dev --bun` no longer waves `.fn.mts` / `.fn.cts` / `.fn.mjs` / `.fn.cjs` into the browser.

  The refusal that keeps a server function off the Bun dev pipeline matched a hand-written glob,
  `**/*.fn.{ts,tsx,js,jsx}`, while both build pipelines stub anything matching
  `/\.fn(\.[cm]?[jt]sx?)?$/`. So a `todos.fn.mts` was a server function everywhere except the one check
  that exists to stop it leaking - it started the dev server and shipped the function bodies, and
  whatever they close over, to the browser. Measured across all eight extensions, four leaked.

  Both refusals now test against the same matchers the transforms use, exported as `SERVER_FN_MODULE`
  and `SERVER_ONLY_MODULE` from `@nifrajs/web`. `SERVER_ONLY_MODULE` had two definitions and now has one
  owner. A test drives every accepted extension through the guard, so widening a convention without
  widening the guard fails there rather than in someone's browser.

- c42d777: `clientEntry` is optional on a `hydrate: false` page.

  A non-hydrated document references it nowhere - all three uses sit behind the `hydrate` guard - yet
  every static page had to pass one anyway. `RenderPageInput` is now a union, so omitting it is allowed
  exactly when `hydrate: false` is set and stays a compile error otherwise, rather than rendering
  `<script src="">` and silently failing to hydrate.

  Found by writing `examples/web-vanilla`, which is the first caller that genuinely has no client entry
  to give.

- ea0a27f: A server function has one type per half, so both the server call and the hook argument are honest.

  ```ts
  export type ClientServerFn<Input, Output> = (
    input: Input
  ) => MaybePromise<Output>;
  export type ServerFnReference<Input, Output> =
    | ServerFn<Input, Output>
    | ClientServerFn<Input, Output>;
  ```

  One type could not describe both halves. `ServerFn` is the SERVER declaration and takes `(input,
context)`; the client imports a generated stub that takes one argument. Widening the single type so a
  one-argument call compiled made a direct server call type-check while handing the declaration
  `undefined` for a context its implementation requires - a runtime failure the compiler had just been
  told to allow.

  Now the two are separate and `useServerFn` accepts either through `ServerFnReference`, which is the
  one place the two halves legitimately meet. Calling a declaration from your own server code needs the
  context, and omitting it is a compile error again.

- d190b1c: Add `@nifrajs/web/fn` - server functions, mounted as ordinary routes.

  ```ts
  // app/actions/todos.fn.ts
  export const addTodo = serverFn(
    {
      input: t.object({ text: t.string({ minLength: 1 }) }),
      capabilities: ["db.write"],
    },
    async ({ text }, c) => db.todos.insert({ text })
  );

  // server
  import * as todos from "./actions/todos.fn";
  app.use(serverFunctions("todos", todos)); // -> POST /_nifra/fn/todos/addTodo
  ```

  A mounted function registers through the ordinary public `register()`, so it is a route like any other
  and inherits the body cap, schema validation, capability declarations, the effect ledger, and
  `nifra assure`. Nothing in `@nifrajs/core` changed and no request-path branch was added, so an app that
  mounts none of them pays nothing.

  Every server function is a public POST endpoint whose arguments the caller controls entirely, so the
  guards are structural rather than documented:

  - **`application/json` only.** A cross-origin form can send only urlencoded, multipart or text/plain,
    so requiring JSON forces a preflight the browser blocks. Both alternatives were measured first: a
    body schema alone still accepts a cross-origin urlencoded form, and `c.boundedJson` alone accepts a
    `text/plain` body crafted to parse as JSON. A function with no input schema has no body reader at
    all, which is where this guard is the only defence.
  - **Same-origin only** when an `Origin` is present - defence in depth behind the JSON requirement.
  - **Input is always validated**; no schema means no argument, never an unchecked one.
  - **No closures.** A function is a module-level export taking explicit arguments, which removes the
    serialised-closure class rather than defending it.

  The client build replaces a `*.fn.ts` module with one stub per export, each POSTing to its mounted
  route, so the function bodies and everything they import never reach a browser.

  `nifra dev --bun` refuses to start on an app that has server functions. Bun's dev-server bundler takes
  no plugins - a runtime `Bun.plugin` onLoad does not reach it, measured rather than assumed - so the
  module would ship whole, secrets included. Refusing matches how that pipeline already handles CSS
  Modules. `nifra build` and `nifra dev` (Vite) transform it correctly.

- a4ecca9: The `.server` convention now holds in every client pipeline, not just one.

  A `*.server.ts` module is server-only: the client build empties it so its import subtree - `node:`
  builtins, native modules, secrets - never reaches a browser. That was implemented once, as a
  `Bun.build` plugin, so it held in exactly one of the four client paths. `nifra build` emptied the
  module; `nifra dev` (Vite), a Vite production build, and `nifra dev --bun` all bundled it whole.

  A guard that holds in one pipeline is worse than no guard, because the file NAME reads as protection
  everywhere it appears.

  - `@nifrajs/web/plugins/vite-server-only` empties the module for Vite, registered in both the dev
    server and the production build. A parity test asserts it emits bytes identical to the Bun plugin.
  - `nifra dev --bun` refuses to start on an app containing one, naming the files - the same treatment
    `*.fn` already had, because Bun's dev bundler takes no plugins and cannot be fixed with one.

  The three `nifra dev --bun` refusals (CSS Modules, `*.fn`, `*.server`) now have tests. Two of them
  guard secrets, and none of them had one.

- de8d992: `@nifrajs/web/service-worker` generates a service worker from a build manifest.

  ```ts
  const sw = generateServiceWorker(manifest, {
    buildId: gitSha,
    offlineUrl: "/offline",
  });
  ```

  Opt-in and generated at build time, so an app that never calls it ships nothing.

  The generated worker is deliberately narrow, because a service worker outlives a deploy and can hand
  one visitor a response produced for another:

  - **Only content-hashed assets are precached.** A hashed URL names its bytes, so cache-first is correct
    by construction; unhashed URLs are left to the network.
  - **Documents are never cached.** Only navigations that FAIL are answered, and only with the static
    offline page you nominate. Caching HTML is how a worker serves one signed-in user the page rendered
    for another.
  - **GET, same-origin, `ok`, not `no-store`.** Everything else goes straight to the network.
  - **The cache name carries the build id**, and activation deletes every older cache, so a stale worker
    cannot pin an old build.

  Omit `offlineUrl` and a failed navigation simply fails - an offline page you have not written is not
  better than a browser error.

- c823915: Typed, validated search params: a route declares a `searchSchema` and both its loader and its component read the parsed, validated query.

  Export a Standard Schema as `searchSchema` from a route. The loader's `ctx.search` becomes the parsed URL query validated against it (typed via `LoaderArgs<typeof app, Env, typeof searchSchema>`), and the component reads the same value with `useSearch<typeof searchSchema>()`. Invalid or hostile input fails closed to the schema's defaults (never a 500); without a `searchSchema`, both are the raw parsed query. Validation runs at match time and the value is derived identically on the server and on client navigation, so a component never parses `window.location.search` by hand and the query it renders hydrates with no mismatch.

  ```tsx
  export const searchSchema = v.object({
    page: v.optional(v.fallback(v.number(), 1), 1),
  });

  export async function loader({
    search,
    api,
  }: LoaderArgs<typeof backend, unknown, typeof searchSchema>) {
    return { rows: await api.reports.list(search).get() }; // search.page is a number
  }

  export default function Reports({ data }) {
    const { page } = useSearch<typeof searchSchema>(); // page: number, SSR-correct
    return <Pager page={page} />;
  }
  ```

  A `_layout` can declare its own `searchSchema` for keys shared across a section (`?org`, `?theme`); the route's effective search merges the layout chain's schemas with the page's, page-wins on a conflict, so both the layout and the page read their validated slice from one object.

  A route can also list `searchClientKeys` - search keys that are purely client-side UI (`?tab`, a client-side `?sort`, `?modal`). When a client navigation changes only those keys, the URL updates (so `useSearch` re-renders) without re-running the loader; any other key change revalidates as before, so data is never stale.

  `useSearch` ships on every adapter - React (a value), Preact (a value), Vue (a `Ref`), Solid (an `Accessor`), and Svelte (an accessor), each in that framework's own shape.

  `navigate` gains an object form on every adapter: `navigate({ to, search, replace })` serializes `search` onto `to` (no hand-built query strings). Run `nifra sync-routes` to generate `nifra-routes.d.ts` (each static route mapped to its schema output) and include it in your tsconfig, and `search` is typed against the target route's `searchSchema` - a wrong shape for a known route is a compile error, while an unmapped path takes a loose `search`. Regenerated from the route files, so a stale shape becomes a `tsc` error. The string-path and history-delta forms are unchanged.

  ```ts
  navigate({ to: "/reports", search: { page: 2 } }); // search typed against /reports's schema
  ```

- 62a8d03: Add `useServerFn` - a server function's pending, data and error state - to all five adapters.

  ```tsx
  const addTodo = useServerFn(fns.addTodo)
  <button disabled={addTodo.pending} onClick={() => addTodo.call({ text }).catch(() => {})}>add</button>
  ```

  Calling a server function never needed a binding: the client stub is `(input) => Promise<Output>`.
  This adds only the state a component wants around it.

  The state machine is `@nifrajs/web`'s `createServerFnStore`, shared by every adapter, so "is it
  pending" has one answer rather than five that drift. Each binding contributes just its subscription
  primitive: `useSyncExternalStore` (React, Preact), a signal (Solid), a `shallowRef` (Vue), a `readable`
  (Svelte).

  Two behaviours worth knowing:

  - **The last call wins.** A response that is no longer the newest is discarded rather than written, so
    a slow first call landing after a fast second cannot overwrite fresh data with stale.
  - **`call` still rejects.** The error is recorded for rendering AND the promise rejects, so `await`
    behaves normally. A caller that only renders from state should attach `.catch(() => {})`, as with
    `useFetcher`'s `submit`.

  `data` is kept while the next call is in flight, so a rendered list does not blank on every refetch.

- dcacfe7: Guard navigation away from unsaved work with `useBlocker`.

  Mirrors react-router's shape: pass a boolean or a `({ currentLocation, nextLocation }) => boolean`
  predicate and get back `{ state, proceed, reset }`. When a navigation is intercepted - a `<Link>` or
  anchor click, `useNavigate`, or a browser back/forward - `state` becomes `"blocked"`, so you render
  your OWN confirmation and call `proceed()` to continue or `reset()` to stay. A plain boolean can't
  express an async "are you sure?"; these two callbacks can.

  ```tsx
  import { useBlocker } from "@nifrajs/web-react/router";

  const blocker = useBlocker(form.isDirty);

  return blocker.state === "blocked" ? (
    <ConfirmDialog onConfirm={blocker.proceed} onCancel={blocker.reset} />
  ) : null;
  ```

  Back and forward are guarded too: the destination URL is restored before you are asked, so the page
  never changes underneath the prompt. It also arms the browser's native "Leave site?" prompt on tab
  close and reload. Idle on the server and before hydration, so it degrades to native navigation and
  stays hydration-safe.

- ea0a27f: The Vite pipelines honour Nifra's public-env boundary, keep `.server` out of the browser on Vite 5,
  and serve a valid ESM replacement in dev.

  **Breaking if you relied on `VITE_*` reaching the browser.** Vite exposes any variable matching its own
  `envPrefix` to client code, and Nifra never overrode it - so an app with one documented boundary
  (`publicEnvPrefix`, default `PUBLIC_`) silently had a second one it had not configured. The dev server
  and the production build now bind Vite's prefix to Nifra's, including the "expose nothing" setting.
  Move anything the browser genuinely needs to your public prefix.

  Two more holes in the same convention:

  - Vite 5 has no `applyToEnvironment`, so the `.server` and `.fn` transforms ran for the SSR graph too
    and stubbed the modules the server itself needs. Both now decline when the transform is told it is
    running for SSR.
  - The `.server` replacement was CommonJS, which is right for the Bun bundler and invalid in Vite dev's
    native ESM graph. Dev now gets inert ESM bindings derived from the module's exported names, with the
    implementation and its imports discarded. A shape the generator does not model declares no binding,
    so the import fails to link - server code is never served as the fallback.

- 0c2de22: Ambient types for a generated `server-manifest` module, so a hand-written server entry that imports `./server-manifest` typechecks before the first build has generated that file - no `@ts-nocheck` on the file that deploys. Reference it with `/// <reference types="@nifrajs/web/server-manifest" />`, or list `"@nifrajs/web/server-manifest"` in your tsconfig `compilerOptions.types`. Once a build (or `nifra sync-manifest`) writes the real file next to your entry, TypeScript resolves the import to it and its types win. Not needed with `nifra build --target`, which generates and bundles its own entry.

### Patch Changes

- 7293a1c: A custom `rootId` hydrates.

  ```ts
  renderPage({ adapter, chain, data, clientEntry, rootId: "app" });
  ```

  That render produced a flawless server-rendered document that then hydrated nothing, forever, with an
  empty console: the generated client entry mounted into `document.getElementById("root")` and skipped
  mounting when it found nothing. Every framework binding, every loader and the whole SSR pass worked,
  and the page was static.

  `rootId` is chosen per RENDER while the client entry is emitted once per BUILD, so an id baked into the
  entry can only ever be a guess. The container announces itself instead - a non-default `rootId` also
  carries `ROOT_ATTRIBUTE` (`data-nifra-root`), which the entry looks for before falling back to `#root`.
  It has to be the DOM and not another `window.__NIFRA_*` global, because a second copy of the id can
  drift from the markup while an attribute written by the same expression as the id cannot.

  A default render emits exactly the bytes it did before - the marker is absent, and `#root` is still
  what the entry finds. When a document has neither, the entry now throws and names what it looked for
  rather than leaving a live page that answers no clicks.

  The container is looked up as `body > div[data-nifra-root]` rather than by the attribute alone. A
  `<meta>` in the head may legally carry any `data-*` attribute, and one carrying this marker appears
  earlier in document order - so an unscoped lookup would hand hydration a tag in the head and mount the
  application into it.

- ea0a27f: The same-origin check works behind a TLS-terminating proxy, and both seams that use it now agree.

  Nifra had two of these - the WebSocket handshake's cross-origin default and the server-function mount -
  and they answered differently for one request, so a browser that could open a socket was told its POST
  was cross-origin. `isSameOriginRequest` from `@nifrajs/core/server` is now the single owner.

  The rule it encodes: the host must match, and the Origin's scheme may be equal or STRONGER, never
  weaker. A server behind Cloudflare, a tunnel or an ingress sees a plain HTTP socket, so `request.url`
  says `http:` while the browser correctly reports an `https:` page - the shape almost every deployment
  produces. Comparing full origins rejects it, which is not the stricter option but an outage: measured,
  every server-function POST returned 403 behind a terminating proxy, while the cross-origin caller the
  comparison aimed at had already been rejected on the host alone. The reverse - an `http:` page against
  an `https:` request URL - is a downgrade with no legitimate cause, and is refused, as is any Origin
  that is not an http(s) page origin at all.

  `X-Forwarded-Proto` is still not read, and that is the point: a forwarded header is attacker-controlled
  unless something upstream is proven to overwrite it, so trusting one by default would hand every
  unproxied deployment a spoofable origin check. Ordering the two schemes reconciles them without it.

- a92104e: The interpolated-SQL rule catches string concatenation, the oldest injection shape.

  ```ts
  db.query("SELECT * FROM users WHERE id = " + req.params.id); // now fails the check
  ```

  The rule inspected template literals only: a quoted string was skipped before the SQL-keyword test ever
  ran. So a codebase predating template literals - or an LLM emitting older-style JS - got a clean
  `nifra check` on textbook-injectable SQL, and `nifra check` reporting clean is a security claim that
  feeds the assurance ladder.

  The same keyword requirement applies, so `cache.query("user:" + id)` stays quiet, and a statement built
  into a variable elsewhere still says nothing at the call site.

  Also fixes the service-worker test suite, whose offline case never reached the code it claimed to test:
  the stub was assigned to `globalThis.fetch` after the worker had already captured `fetch` as a
  parameter, so the assertion was satisfied by a real network failure. A worker mutated to serve the
  offline page to every visitor passed all 19 tests; it now fails, and an online navigation is covered.

- 28704d7: The dev server's public-env boundary is covered by a test that drives it.

  Vite inlines any `VITE_*` variable into client source by default, which is a second boundary running
  beside Nifra's `PUBLIC_` one - so a `VITE_DATABASE_URL` reached the browser without passing the policy
  meant to decide that. Both pipelines were fixed, but only the production build was tested. A guard
  holding in one pipeline while the option reads like protection in both is the exact shape of the bug
  that motivated the fix.

  The dev server now has the equivalent: a real dev server, a module asking for both variables, and an
  assertion about what it actually serves. It fails without the fix, and it cannot pass on an error page.

- Updated dependencies [6f5b3ad]
- Updated dependencies [85b354d]
- Updated dependencies [8514caa]
- Updated dependencies [ea0a27f]
- Updated dependencies [ea0a27f]
- Updated dependencies [b271164]
- Updated dependencies [8c77d47]
- Updated dependencies [ea0a27f]
- Updated dependencies [5fe332a]
- Updated dependencies [d2840ac]
  - @nifrajs/core@2.3.0

## 2.2.0

### Minor Changes

- 39b1670: `@nifrajs/web/dev` runs on Bun's native HMR, so the Bun pipeline no longer needs Vite anywhere.

  nifra has two dev pipelines and one rule between them: a pipeline owns a whole phase. The Vite server
  stays the default and now resolves SSR as well as the client, so both halves agree on every specifier.
  This is the other half of that split. `Bun.serve` bundles and hot-reloads the client, Bun's runtime
  resolves SSR, and only one toolchain is present - so the two cannot disagree. Previously this server
  rebuilt the whole client and forced a full page reload on every save; now Bun rebuilds incrementally and
  pushes over its own HMR socket.

  Joining the two halves takes some care, because Bun's dev server bundles HTML routes and nifra renders the
  document itself. A throwaway HTML route exists purely so Bun bundles the generated client entry and
  assigns it a URL, which nifra reads back and points its pages at. Three things follow from that, each of
  which is a silent failure if you skip it:

  - **The entry URL expires.** It is a content hash over the whole client graph, so any file the entry
    reaches re-hashes it. Pages therefore reference a stable nifra URL that redirects to whichever chunk Bun
    is currently serving. Injecting a remembered URL is not a stale-cache annoyance: Bun answers a
    superseded chunk with a `location.reload()` stub, so the page reloads, gets the same dead URL from SSR,
    and loops forever - with every reload wiping the console that would have explained it.
  - **Stylesheets have to be carried across.** Bun lifts `import "./app.css"` out of the JS graph and links
    it from the page it bundled, which is the throwaway. Without forwarding those links, the entire dev
    session renders unstyled while production, which reads CSS from the build manifest, is perfectly fine.
  - **SSR freshness is ordered by request, not by clock.** Bun rebuilds and reloads the browser the instant
    a file is saved, which is faster than any file watcher can answer; SSR rendered from a watcher tick is
    still on the previous code when that reload lands, and React discards the server tree with a hydration
    mismatch. Rebuilding when Bun's entry hash moves - the same value already fetched to render the page -
    removes the race instead of shrinking it.

  The client-leak guards still run. Bun's dev server does its own bundling, so the `buildClient` pass that
  enforces them is no longer on the path that serves the app; it now runs beside the dev loop, off the hot
  path, and reports. These stop server-only code and `node:` builtins reaching a browser, and a dev loop
  that quietly stops enforcing them is how a leak reaches a deploy. Opt out with `guardLeaks: false`.

  Reading Bun's output for the entry URL is isolated in one adapter with its own tests, including one that
  runs a real Bun dev server and fails if the markup Bun emits ever changes shape - so a Bun upgrade breaks
  a test rather than producing a dev server that boots cleanly and serves pages whose scripts 404.

  Both pipelines now report a port collision the same way, since `Bun.serve` throws synchronously where
  Node's http server emits an async `error` event.

- 1394641: Layout loaders: request data in the component that wraps every page.

  `routes/_layout.tsx` rendered, but a `loader` it exported never ran, so nothing request-derived could
  reach a layout - host, session, locale, feature flags, tenant. An app hit this and moved its host guard
  out of the component tree into the server entry, where it could not be typechecked with the rest of the
  app. That is the real cost: the gap pushed security-relevant code to the one place nifra's typed-boundary
  promise does not reach. Remix, React Router and SvelteKit all support this; nifra was alone in not.

  ```tsx
  // routes/orgs/[org]/_layout.tsx
  export const gate = true                       // optional; see below
  export async function loader({ params, req }) {
    return { org: await findOrg(params.org) }    // params is { org } - nothing deeper
  }
  export default function Layout({ data, children }) { … }
  ```

  **Scoped, not global.** A layout owns the URL prefix it wraps, so it receives only the params inside
  that prefix and its loader is skipped on a navigation that did not change them. Navigating
  `/orgs/acme/a` → `/orgs/acme/b` does not re-run the org layout's loader. Scope is derived at build time
  per `(route, layout)` pair, because one layout can own different params on different expanded patterns:
  `[[lang]]/docs/_layout` owns nothing on `/docs/:slug` and `{lang}` on `/:lang/docs/:slug`. Layouts are
  not router nodes and did not become any - the router is untouched.

  **Execution order is declared, and this matters for security.** By default a layout loader runs in
  parallel with the page's, which is right for data and wrong for a guard: a page loader running
  concurrently with a guard has already queried by the time the guard says no. `export const gate = true`
  makes a layout blocking - nothing beneath it runs until it resolves, and nothing beneath a rejected gate
  runs at all. **A layout loader without `gate: true` is not an authorization boundary.** Gates also run on
  the data-only request, so a client navigation cannot bypass one by sending the data header, and a gate is
  never skipped by the retention hint.

  A layout may throw `notFound()` / `gone()` / `redirect()`. Its errors resolve to the `_error` boundary at
  or above its OWN segment, never one below it - rendering there would wrap the boundary in the very layout
  whose loader just failed.

  Every adapter passes each layout its own data. A layout with no loader receives `null`, and an app where
  no layout has a loader emits byte-identical HTML and unchanged props.

  The data-mode response becomes a versioned envelope when a chain carries layout data. It is recognised
  by structure, and the bare pre-envelope shape is still accepted - a prerendered `_data.json` is a static
  file that outlives the deploy that wrote it.

- e713cab: Let a route loader answer 404 and 410.

  A matched route whose loader finds nothing had no supported way to set its page's status, so the path
  of least resistance was to return empty data and render "not found" inside a **200**. That is a soft
  404: search engines penalise it and keep the dead URL indexed, and because the page looks correct in a
  browser it ships and stays shipped. It is the most common page shape there is - a detail route whose
  record may not exist.

  `notFound()`, `gone()`, and `statusPage(status)` are thrown from a loader, the way `redirect()` already
  is. They render the `_404` page - or `_410.tsx` / `_<status>.tsx` if the app authored one - inside the
  normal layout chain, hydrated, at the right status. A `headers` option carries the cache policy each
  status wants: a 404 may be racing publication and wants a short TTL, while a 410 is a promise that the
  URL is permanently gone. Typed `never`, so a loader narrows without a redundant `return`.

  410 is not a pedantic 404: it tells a crawler to drop the URL instead of re-fetching it for weeks.

  Existing behaviour is unchanged by construction. The signal is a branded `Response` and the brand is
  checked before the verbatim pass-through, so `throw redirect(...)`, `throw new Response(...)`, and a
  real `Error` reaching `_error` all behave exactly as before. Client-side navigation and prerendering
  already handle a non-ok render correctly and now have tests pinning that: a soft-nav falls back to a
  full navigation and lands on the same page, and a prerendered path whose loader signals is omitted
  from the build rather than baked as a static 200 shell.

  `renderPageResult` gains a `headers` option. `content-type` and the ISR freshness header stay
  framework-owned and cannot be overridden through it.

  Also trims the router's rejected-parameter message added in the previous release. The explanation cost
  ~0.3 KB gzip in every bundle; it now states the grammar rule and the two ways out without building an
  example path, which is a third smaller and keeps the base bundle inside its budget.

- a4645e2: Support path segments that are part literal, part parameter.

  A route segment had to be wholly static, wholly a parameter, or wholly a wildcard. `/:key.txt`,
  `/post-[id].html` and `/[locale]-sitemap.xml` did not merely fail to match - they failed to
  **compile**. The trigger was an IndexNow key-verification file, which the protocol requires at
  `<origin>/<key>.txt` with the key coming from deploy-time config, and at the root, because a key
  served from a subdirectory only authorises URLs beneath it. The workaround was an exact-match check in
  the app's server entry, which moved a routing concern out of the router and never ran in dev.

  Both spellings now work: `:key.txt` in a route pattern, and `[inKey].txt.tsx` as a file route. The
  parameter name is the longest identifier run after `:`; everything else in the segment is literal.
  Precedence is static > mixed > param > wildcard, decided by shape rather than registration order, so
  `/robots.txt` still beats `/:key.txt` and `/jobs/:id.txt` beats `/jobs/:id`.

  Inside a mixed segment, `[[optional]]` and `[...catchAll]` are **rejected** at build time rather than
  given a meaning: there is no sensible absent form for `/[[locale]]-feed.xml`, and a catch-all captures
  the rest of the path, which a trailing literal can never follow.

  **Literal colons keep their meaning.** A `:` that follows an identifier character and runs to the end
  of its segment is literal, so the established RPC-style action shape - `/v1/things:batchGet` - still
  routes as written rather than capturing `batchGet` into a parameter named after the verb. Mixed
  parameters remain available everywhere they are unambiguous: at the start of a segment (`/:key.txt`),
  after punctuation (`/post-:id`), or with a literal suffix (`/v:major.json`). A `:` not followed by a
  valid identifier start (`/ratio:2`) is literal as before.

  Mixed siblings are ordered by ONE total comparator shared between the server's trie router and the
  browser's matcher. Ordering by literal weight alone left ties broken differently on each side, so
  `/bar.:value` and `/:value.foo` could resolve to different routes for the same URL - visible only as a
  soft navigation rendering the wrong page.

  Adding a mixed pattern can also make a previously unambiguous path ambiguous: with both `/jobs/:id` and
  `/jobs/:id.txt` registered, `/jobs/a.txt` now matches the mixed route with `id="a"` where before it
  could only match the bare param with `id="a.txt"`. Deterministic, and only for apps that opt in by
  registering a mixed pattern.

  An app that registers no mixed segment allocates nothing for this and pays one `undefined` check on
  the match path. The rejected-parameter hint added in the previous release is removed - `:id.json` was
  the shape it explained, and `:id.json` now compiles.

- a7d740a: Mount sub-apps and standalone-shaped backends without a `Proxy`; bound the render worker; lint removed imports.

  **`mounts` and `apiStrip` on `createWebApp`.** Two shapes previously needed a hand-written ~40-line
  `Proxy` around the backend. The auto-mount dispatches the full `/api/v1/forms`, but a backend that also
  runs standalone declares its routes without the prefix and lets its own shell supply it - so every
  request 404'd inside it. And better-auth is not a `backend` route, so `/api/auth/*` hit the backend and
  404'd silently. `apiStrip: true` removes the prefix before dispatch, and `mounts` takes any
  `{ path, app: { fetch } }` - so any library exposing its routes in that shape mounts directly, with no
  dependency from `@nifrajs/web` on it. Mounts are matched longest-path-first and before the `api`
  prefix, so `/api/auth` wins over `/api` regardless of declaration order.

  **A layout that exports a `loader` now fails loudly.** Layouts do not run one - only route files do -
  and rendering while ignoring the export was the worst possible handling: it looks wired, the page
  renders, and the data is simply never there. The error names the file and says where the fetch should
  go instead. Running loaders in layouts is a real feature and is not this change.

  **`nifra_render` and `nifra_run` can no longer hang.** The cold-path child wrote its result and then
  fell off the end of the module without exiting, unlike the warm-worker branch beside it. Loading an
  app runs its module side effects, so a database pool, a Redis client, or an interval kept the child's
  event loop alive forever while the parent waited on `proc.exited`. The child now exits explicitly, and
  both the cold and warm paths carry a 30s timeout as a backstop, reporting the likely cause rather than
  hanging.

  **A `removed-import` lint in `nifra check`.** `@nifrajs/budget` folded into core in 2.x with no npm
  deprecation - `latest` is still 1.13.0, so a `^2` range resolves to nothing and `bun install` fails
  workspace-wide with an error naming neither cause nor replacement. The 2.0 WebSocket change has the
  same shape: `import "@nifrajs/core/ws"` no longer installs the runtime, and a consuming package kept
  it while its whole test suite stayed green and the app could not boot. Both are now caught before
  boot, with the replacement named. The WS rule flags only the bare side-effect form, since the module
  still exports `websocket` and a rule that fires on correct code gets ignored.

- 6e996a1: A dev/prod parity gate, and the CSS Modules divergence it immediately found.

  nifra runs two pipelines and each is internally coherent: dev is Vite end to end, production is Bun end
  to end. That split is deliberate. What is not acceptable is the two regimes disagreeing about a fact an
  app depends on, because that failure always presents the same way - as "it worked locally", discovered
  after a deploy. The gate builds one fixture app through both pipelines and asserts they agree on four
  facts, each of which is a bug that already shipped or the mechanism behind one: the served `public/` set
  (byte-for-byte, not just the path list), that a module imported by two routes stays one module, CSS
  Modules behaviour, and the route manifest.

  Scoped CSS class names are deliberately not compared. A scoped name never crosses the regime boundary,
  since each regime compiles both of its own halves, so requiring equal hashes would freeze both naming
  schemes forever while proving nothing. What is compared is the contract: the same exported keys, every
  one actually scoped, and `:global` left alone on both sides.

  That comparison found a real divergence on its first run. `@keyframes` names are part of the CSS Modules
  export namespace - postcss-modules exports them, so Vite does, so nifra's dev pipeline did - but the Bun
  plugin omitted them. `styles.spin` was therefore a usable scoped name in dev and `undefined` in
  production, with no error at either end. Keyframe names are now exported, so anything reaching for one
  (`style={{ animationName: styles.spin }}`) behaves the same in both.

  When a file has both a class and a keyframe under one name, the class wins the export. That resolution is
  fixed by construction rather than by declaration order, because a name that has to agree across two
  pipelines cannot depend on which rule was seen first; the keyframe stays scoped in the stylesheet under
  its own distinctly salted name either way.

  `createViteDevServer` also now reports the port it actually bound rather than the one it was asked for.
  They differ for `port: 0` - the way to ask the OS for a free port, and what a test or a second app wants -
  where it previously echoed back a literal `0`, which connects to nothing.

- 6aa0aac: Add `previewEndpoint` for draft/preview mode, and make transport codec decode errors uniform.

  `previewEndpoint({ secret, draftSecret })` is a `fetch` handler for the link your CMS's "Preview"
  button points at: it checks the preview token in constant time, turns draft mode on with the signed
  `__nifra_draft` cookie, and redirects the editor to the requested page. It is the link-borne sibling
  of `revalidateEndpoint`, and it exists because gating the route by hand means writing two checks that
  are easy to get subtly wrong and that fail silently when you do - the token compare must not exit
  early on the first wrong character, and the `?to=` destination must not be allowed off-site
  (`//evil.com` and `/\evil.com` both start with a slash yet navigate away). Wrong or missing token
  gives `401`, an off-site destination `400`, and success a `302` carrying `Cache-Control: no-store`
  so no shared cache can replay one editor's draft session to a visitor. Param names, the fallback
  destination, and cookie lifetime/path/`Secure` are all configurable.

  `decodeTransportFrame` and `decodeTransportResponse` now raise `TransportCodecError` for a malformed
  payload instead of letting the underlying `SyntaxError` through, with the original kept as `cause`.
  Every other failure in that module was already a `TransportCodecError`, so a malformed payload - the
  likeliest hostile input - was the one case that slipped past callers catching the documented error
  type. `TransportCodecError` accepts an `ErrorOptions` second argument to carry that cause. Bytes that
  are not valid UTF-8 take the same path: the `TypeError` from the strict decoder used to escape ahead
  of any codec, so the one input that never reached a codec at all was also the one that reported
  differently from every other decode failure.

- 1857d39: Serve `public/` in production, not just in dev.

  `nifra dev` served a project's `public/` directory; production did not. There was no `publicDir`
  concept anywhere - dev got the behaviour for free because the HMR path runs on Vite, and Vite serves
  `public/` by default. So a file worked all the way through development and 404'd the moment it was
  deployed, and every app had to notice this and hand-roll static serving in its own server entry.

  The failure is inverted, which is what makes it expensive: it appears only in production, and only for
  the assets nobody smoke-tests. It has already shipped once as a self-hosted webfont that 404'd in prod
  and silently fell back to a system font. Nothing errored and nothing alerted.

  `publicDir` (default `"public"`) is now a first-class option. The build copies the directory into the
  output and records the file list on the build manifest, and `servePublicDir` is exported for a server
  entry to mount. Dev routes through the **same** handler rather than inheriting Vite's - two code paths
  with different defaults was the whole bug, so there is now one owner.

  Behaviour, matching what apps arrived at independently: only paths with a file extension are probed,
  so a page route never pays a filesystem stat; a miss falls through to routing, so no route is shadowed;
  and cache headers differ by subtree - content-hashed `/assets/*` immutable, `public/` a day, both
  overridable. Path traversal is confined by resolving and then verifying containment, rather than
  scanning the input for `..` - a blocklist over encodings is the version that gets bypassed - and
  percent-encoded and NUL-bearing paths have tests.

  Note that `publicPath` is a different thing: the URL prefix for content-hashed bundle chunks. It never
  covered user-authored files, and the name similarity actively misleads.

  `nifra check` now points out that an app with a `public/` directory can delete its hand-rolled static
  serving. A tip rather than a finding - an existing handler still works, since it runs first.

  On Cloudflare Pages the copied files are named individually in `_routes.json` so the CDN serves them
  without invoking the worker, within Cloudflare's cap of 100 include+exclude rules of at most 100
  characters each. An ordinary `public/` of icons, fonts and share images clears that cap, and the
  rejection lands at `wrangler pages deploy` - after a build that reported success.

  Past the cap a directory is compacted to one `/dir/*` rule, but only after checking it against the
  app's real route patterns. The glob does not merely describe today's files; it hands Pages every future
  path under that prefix, so a `public/blog/hero.png` beside a `/blog/:slug` route would send
  `/blog/my-post` to a CDN that has no such file and 404 the page in production only. A directory
  therefore collapses only when no route can be served beneath it, and a single route with a dynamic
  first segment (`/:locale/…`) disables collapsing everywhere, since it can match under any name. A
  collapsed directory does give up the app's 404 page for a missing file beneath it - the right trade for
  a directory of static files, where a missing image should fail as a fast CDN 404 rather than an HTML
  error page.

  Whatever still does not fit is dropped rather than widened, which is safe because the list is only an
  optimization: the emitted worker serves any path it recognises through the `ASSETS` binding, so an
  omitted file costs one worker invocation rather than a 404, and nothing else reaches that binding. The
  build prints how many it left out, since a cap you cannot see reads as coverage you do not have.

- 6ba3173: `nifra routes --modes` - every route's render mode, hydration, and cache policy, gated against the target.

  The facts were always in the route modules: `prerender`, `getStaticPaths`, `revalidate`, `hydrate`.
  Nowhere read them together. Answering "which pages are static?", "which revalidate, how often?", "which
  ship no JS?" meant opening every route file and holding the answer in your head - and the answer changes
  with the deploy target, which is nowhere near the route file.

  The new `@nifrajs/web/route-manifest` derives one record per route - static | isr | ssr, hydration, cache
  policy - and resolves it against a target. `nifra routes --modes` prints the table; `--modes --target <t>`
  gates: a route the target cannot honour exits non-zero, so CI fails the build instead of production
  failing the request. The two cases that were previously silent are exactly the ones it catches: an ssr or
  isr route in a `static` build (no server, so the URL 404s in production while working in dev), and ISR
  where the target has no revalidation. Each conflict names the consequence, not the rule.

  Two derivations are deliberate. `prerender` wins over `revalidate`, because a page rendered at build time
  is not revalidated at runtime - the build-time answer is the one that ships. And a dynamic route counts as
  static only once the build has actually emitted paths for it: `getStaticPaths` is the intent, the emitted
  paths are the evidence, and treating intent as sufficient is how a "static" build ships a page that 404s.
  Pass the paths `prerenderRoutes` produced via `buildRouteManifest`'s `prerendered` option to resolve those
  routes against what was really built.

- 0fc215b: The Vite dev pipeline now resolves SSR too, which removes the dual-React class of bug.

  `nifra dev` served the client through Vite while resolving route modules for SSR through Bun - two
  resolvers disagreeing about one specifier, inside one process. That is what made `resolve.dedupe`
  govern only half the app: an app added a hand-written React alias in `nifra.config.ts`, and it still
  crashed, because the alias reached Vite and SSR never asked Vite. The symptom named a React internal
  (`resolveDispatcher().useState` is null), so the actual cause - two copies at different paths - was
  hours of inference away.

  `discoverRoutes` accepts a `load` option, and the Vite dev server passes `ssrLoadModule`. Both halves
  now resolve through the same toolchain, so an alias, a `dedupe`, or a condition configured for the
  client governs the server as well.

  Two things follow from that and are removed rather than kept "just in case":

  - **Bun's SFC plugins are no longer registered in `nifra dev`.** Vite compiles `.vue` / `.svelte` /
    Solid for SSR through the app's `vitePlugins`. Registering Bun's alongside was the intermix itself -
    two toolchains compiling one file, only one of them governed by Vite's resolution. `nifra start` and
    the build path keep theirs, which is correct: those are the Bun pipeline.
  - **The `importQuery` cache-buster is gone from the Vite path.** It existed to defeat Bun's import
    cache; Vite re-evaluates changed modules itself. `discoverRoutes` ignores `importQuery` when `load`
    is supplied, because appending one would mint a new module id per request and defeat that.

  The dev server still re-creates the app on change, now only so a hard reload picks up a route add or
  remove - the manifest comes from a directory scan, which `ssrLoadModule` cannot invalidate.

- 2ff661f: The full Vite/Rollup production build: `buildClientVite`, `buildServerVite`, `buildTargetVite`, and `nifra build --vite`.

  Production stays Bun by default - faster and Bun-native, the profile nifra is tuned for. This completes
  the escape hatch for the one case that default cannot serve: an app whose client needs a Vite-only
  transform with no Bun equivalent. It now has a real, full production path, not just the leak-guard plugin.

  The design point is that this is NOT a second orchestrator. `buildTarget`'s deploy assembly - per-target
  server-entry codegen, `_worker.js` / `server.js` placement, `_routes.json`, prerender, size report - is
  bundler-agnostic and now lives behind `buildTargetWith(target, options, bundler)`, which takes a `Bundler`
  strategy (its two bundling steps). `buildTarget` passes the Bun strategy; `buildTargetVite` passes the
  Vite one. So the deploy-dir shape is produced in exactly one place and cannot drift between pipelines -
  `buildTargetVite` emits the identical directory for every target.

  `buildClientVite` reconstructs the same `BuildManifest` the Bun `buildClient` does - content-hashed entry,
  per-route chunk lists, aggregate + per-route CSS, copied `public/` - from Vite's own `.vite/manifest.json`.
  It wires `viteLeakGuard()`, and it keeps `node:` builtins external so the guard names the offending builtin:
  left alone, rolldown-vite silently rewrites a `node:` import to a browser stub, which builds and ships and
  is a no-op at runtime - a worse footgun than Bun's polyfill, now a build failure. `buildServerVite`
  produces the same self-contained `ServerBuild`, tagging the bundle `NIFRA_SSR_BUNDLED` so the web-react
  adapter uses the bundled, deduped react-dom rather than re-rooting to a disk copy.

  `nifra build --vite` selects the pipeline; the app's Vite plugins drive both halves. Verified end to end by
  building the React example for the `node` target, running the server, and confirming SSR plus live
  hydration in a real browser, alongside `cf-pages` (`_worker.js` + `_routes.json`) and `static` (prerender,
  no server) deploy shapes.

  No change to the default Bun build: `buildTarget` now delegates to `buildTargetWith` with the Bun strategy,
  and its behaviour and output are identical.

- a1327a4: A Vite/Rollup production build carries the same client-leak guards as the Bun build.

  Production stays Bun by default - it is faster and Bun-native, and that is what nifra competes on. But
  some apps need a Vite-only transform with no Bun equivalent, and for those a Vite/Rollup production client
  build is the escape hatch. The moment that hatch exists, the two client-leak guards have to come with it:
  they are security guards, not lints - one stops secrets and database access shipping to a browser - and a
  second production pipeline arriving without them, or with a "mostly ported" copy, is exactly the failure
  the bundler-neutral module graph was introduced to prevent.

  `@nifrajs/web/plugins/vite-leak-guard` is not a second implementation. It adapts Rollup's bundle into the
  neutral `ClientModuleGraph` (`fromRollupBundle`) and runs the SAME `detectNodeBuiltinsInClient` /
  `detectServerOnlyInClient` the Bun build runs, through the SAME failure messages - now extracted so both
  pipelines share one owner. A `node:` builtin or a `server-only`-marked module reaching the client fails
  the build identically whichever bundler produced it, including via dynamic `import()`.

  One adapter subtlety is load-bearing: the guards locate a leak by finding the builtin inside a chunk's
  module list. Bun bundles the `node:` polyfill, so it appears there; Rollup externalizes `node:`, so it
  never would - the adapter synthesizes the builtin into the importing chunk so the neutral graph is
  identical to Bun's. Proven with a real `vite build` that fails on a real leak (static and dynamic) and
  passes clean code, alongside unit tests asserting the two adapters yield the same finding.

  No behaviour change for existing Bun builds: the guard logic and messages are unchanged, only relocated
  behind shared formatters.

### Patch Changes

- d428f52: `nifra dev` names a port collision instead of dying inside `node:events`.

  Starting the dev server while an earlier one still holds the port produced a raw internal stack from
  Node's event emitter and killed the new process in the background. The old server kept answering on that
  port, so the browser carried on rendering the previous build. The symptom that reaches the developer is
  not "the port is taken" but "my edits stopped reaching SSR" - which reads as broken HMR or a stale module
  graph and sends you looking anywhere but at the one process that never started.

  Binding now fails with the port named, the stale-output consequence spelled out, and both fixes given
  with the port already substituted: free it, or take the next one. Vite is torn down on that path, because
  by the time the bind is attempted its watchers and dep optimizer are holding the event loop open - a
  handled error alone would leave the process printing a diagnosis and then hanging on it, which looks
  exactly like a dev server still starting up. Other bind failures pass through unchanged rather than
  inheriting port-collision advice that would not apply.

- 135d0c6: Find duplicate installs when `nifra check` runs from an app subdirectory.

  The duplicate-install check anchored its discovery at the directory it was run from. In a monorepo you
  run it from the app - `apps/web` - and that manifest declares no `workspaces`, so the scan collapsed to
  the app itself and the sibling package holding the second copy was never probed. It printed
  `✓ duplicate identity-sensitive dependency install: none` while the dev server returned 500 on every
  page using a shared-kit hook, from exactly the condition the check exists to detect. Running from an
  app subdirectory is the normal case, so that was the configuration it was blind in.

  Discovery now walks up to the workspace root that actually governs the directory, and probes from
  there. An ancestor is adopted only when its `workspaces` patterns genuinely match - a parent that
  merely contains a manifest is not this project's root - and the walk stops at a `.git` boundary.
  Findings are still reported relative to where you ran the command.

  **Expect this to start reporting real findings in monorepos that were previously green.** That is the
  point rather than a regression: the duplicate was always there, and the check simply never looked in
  the right place.

  An SSR error carrying a duplicate-instance signature (`resolveDispatcher()`, `Invalid hook call`, a
  null hook read) now names the likely cause. Two copies at the same version still fail, because module
  identity is path-based, and the raw error points at a React internal - so the message now says two
  copies are installed at different paths, that matching versions do not fix it, and to run
  `nifra check` for the paths.

- 15ad6ca: Enforce pipeline separation, and make the client-leak guards bundler-neutral.

  nifra supports both Vite and Bun, and the config already keeps them in separate slots - `vitePlugins`
  for the Vite pipeline, `clientPlugins` / `serverPlugins` for the Bun one. Nothing enforced the split,
  and the failure mode is silent: `Bun.build` has no `transform` hook and Vite never calls `setup`, so a
  plugin in the wrong slot is accepted, never invoked, and the build succeeds with the transform simply
  missing.

  Loading an app now refuses that config, naming the plugin, the slot it is in, the pipeline that slot
  feeds, and where to move it. Checked at load rather than in `nifra check`, which holds a deliberate
  pre-`loadApp` invariant - reading plugins means importing the app's config. So `dev`, `build` and
  `start` are covered from one place, immediately before the plugins reach a bundler. Detection is by
  hook shape and deliberately conservative: a plugin matching neither shape is left alone, because a
  guard that fires on correct config is a guard people turn off.

  The two client-leak guards - server-only code reaching the browser, `node:` builtins in client code -
  now take a bundler-neutral module graph instead of Bun's metafile, with a `fromBunMetafile` adapter
  behind it. Nothing changes today: Bun remains the only producer and the existing 19 tests pass
  unchanged, now routed through the adapter so it is covered too.

  The point is what it makes possible. These are security guards - one stops secrets and database access
  shipping to a browser - so a second production pipeline must not arrive without them, and porting them
  under pressure beside a new bundler is how a guard ends up "mostly" ported. Introducing the seam while
  Bun is the only producer means the adapter can be verified against known-good behaviour, and adding
  Rollup later is one more adapter rather than a second copy of the detection logic.

- ca71a2e: `nifra_types` collapses oversized declarations in search results, and a bad `clientModule` says so.

  **`nifra_types` query mode.** A search returned the complete declaration of every match, and the corpus
  is wildly uneven: the median symbol is small while `Server` alone is ~32,000 characters, five times the
  next largest. One broad query that happened to match it returned the entire class for near-zero value.

  A `query` now returns a one-line summary plus the signature, collapsing an oversized body to its head
  and a member count, and saying which `name` call returns the rest. Measured on the real corpus:
  `"server"` drops from 36,355 to 1,739 characters (95%), `"route schema"` by 87%, `"rate limit"` by 69%.

  An exact `name` lookup is **never** collapsed - there the caller asked for that symbol. Pass
  `full: true` to opt a query back into whole declarations.

  **`clientModule`.** The option is a module specifier resolved by the bundler, so nothing type-checks
  that the module actually exports `mountRouter`. A self-executing client entry therefore built cleanly
  and failed at first paint with `mountRouter is not a function`, from inside a bundled chunk, naming
  neither the module nor the requirement - diagnosable only by reading `build.ts`.

  The generated bootstrap now throws immediately, naming the offending specifier, the missing export, its
  call signature, and the specific trap that a self-executing entry will not work. The contract is also
  spelled out on the option's own type rather than in a parenthetical.

- 2500705: The Vite production build now works on runtimes whose `Error.captureStackTrace` is stricter than V8's.

  `captureStackTrace` is a V8 API and V8 decorates any object handed to it. Some runtimes require a real
  Error - one with the internal slot, which an object merely inheriting `Error.prototype` does not have -
  and throw `First argument must be an Error object`.

  Vite bundles `follow-redirects`, which defines its error types the pre-class way:

      CustomError.prototype = new (baseClass || Error)()

  That constructs the base class while defining the subclass, so `captureStackTrace` receives an object
  that inherits from Error but was never built by it. On a strict runtime the throw happens while vite's
  own module is still evaluating, so `import("vite")` fails outright and every Vite build dies with a
  message about stack traces that names nothing about vite.

  `loadVite` now probes for that strictness and, only when present, restores the V8 contract: it delegates
  to the runtime and swallows the refusal, since decorating a stack is best-effort. A runtime that already
  follows V8 is left untouched.

  Also: a Vite build that fails for any reason no longer reports "vite is not installed" when vite is
  installed and merely failed to load - a resolution failure and an evaluation failure are now described
  as what they are.

- Updated dependencies [5f460db]
- Updated dependencies [e713cab]
- Updated dependencies [a4645e2]
- Updated dependencies [6aa0aac]
  - @nifrajs/core@2.2.0

## 2.1.0

### Minor Changes

- bd294bb: Add `executeCapability()` as a correlated, policy-aware effect boundary.

  - Correlate intent and terminal evidence with a random `effectId`, record committed/failed outcomes
    automatically, and combine request cancellation with bounded async `aroundCapability()` admission
    policies while preserving the synchronous `useCapability()` path.
  - Retain idempotency results for every completed response, including non-2xx outcomes, so a retry
    cannot repeat an effect that succeeded before a later handler failure.
  - Add durable approval, effect journal, saga/compensation, and reconciliation primitives behind the
    `durable-execution` subpath, plus token-only OpenTelemetry effect spans from `@nifrajs/otel/effects`.
    Reconciliation supports bounded cursor pages, approval resume tokens stay out of ordinary error
    serialization, durable terminal states are monotonic, crash ambiguity has an effect-ID-bound operator
    resolution API, and unmatched effect spans have bounded retention.
  - Add one shared owned-effect scope across capabilities, saga execution, compensation, idempotency
    evidence, durable transitions, and telemetry. An explicit `markIdempotencySafeToRetry()` outcome
    releases a resolved 5xx only while the scope proves no effect began.
  - Add negotiated, versioned transport codecs with bounded plain-JSON and rich-wire adapters for HTTP,
    the typed client, loader NDJSON, and WebSocket frames.
  - Add Postgres, SQLite, and Durable Object durable-execution adapters with one reusable conformance
    suite, plus leased reconciliation workers with bounded pages/concurrency, durable cursors, filters,
    cancellation, backpressure, and token-only metrics.

### Patch Changes

- Updated dependencies [bd294bb]
- Updated dependencies [d3aac63]
  - @nifrajs/core@2.1.0

## 2.0.0

### Major Changes

- d91a45b: Remove Nifra's remaining deprecated and compatibility-only public surfaces for the 2.0 cutover.

  - `@nifrajs/core` and `nifra` now expose only the lean HTTP server API at their package roots. Import
    optional systems from their documented subpaths. The deprecated invariant runner and the
    `@nifrajs/budget` compatibility package are removed; use `@nifrajs/testing` and
    `@nifrajs/core/budget` respectively.
  - Web redirects accept only an options object as their second argument, the prerender enumeration
    wrapper is removed in favor of `enumerateStaticRoutes()`, and fragment navigation resolves IDs only.
  - MCP Apps metadata uses only `_meta.ui.resourceUri`; the deprecated flat `ui/resourceUri` key is gone.
  - Telemetry uses `ObservationAdapter` directly; the `AgentSpan`, `AgentSpanExporter`, and `SpanExporter`
    aliases are removed.
  - Invalid HTTP method overrides always fail closed with 400; the legacy ignore mode is removed.
  - `nifra build` always emits a complete target deploy directory and defaults to Bun. The old
    client-only build branch is removed; `nifra start` runs the generated Bun `server.js`.

- d91a45b: The in-process backend mount is now exclusively the symbol-keyed `BackendMount` interface that `inProcessClient()` / `testClient()` implement.

  `createWebApp({ api })` auto-mounts a backend only through that symbol seam - the platform-aware path that forwards `env` / `waitUntil`. The `.fetch(url, init)` mount convention is gone: an `api` that only exposes a callable `.fetch` is no longer auto-mounted. Backends passed as `inProcessClient(app)` / `testClient(app)` are unaffected, since they carry the symbol mount already.

### Minor Changes

- e97a92f: `nifra sync-manifest`, plus two toolchain guards that turn opaque failures into actionable ones.

  - **`nifra sync-manifest`.** After adding/renaming/removing a page route, the committed `server-manifest.ts` drifts and `nifra check` flags it - and clearing that used to mean a full build (server + worker + migrate bundles). `nifra sync-manifest` re-scans `routes/` and rewrites just the manifest's route table in milliseconds, preserving the baked client-asset references. It does not rebuild the client bundle, so it prints a caveat: a brand-new hydrating route component still needs a full build for its client chunk. `@nifrajs/web/build` gains the pure `resyncServerManifestSource` (+ `parseManifestStyles` / `parseManifestRouteStyles`) it is built on.
  - **`nifra dev` peer preflight.** Run under `bunx @nifrajs/cli dev` (an isolated install where the project's peers do not resolve), the Vite import failed with an opaque `ERR_MODULE_NOT_FOUND`. It now checks `vite` resolves from the project first and, if not, says to run the workspace-local `bun run dev`.
  - **`nifra start` build-target guard.** Pointed at a Cloudflare Pages output (a `_worker.js` bundle, no `server.js`), `nifra start` now names the mismatch and the fix (`nifra build --target bun`, or serve with `wrangler pages`) instead of a bare "no server.js".

- e8e49d1: Two new build plugins for the `Bun.build` production step, both opt-in and dependency-free until used.

  - **`postcssBunPlugin` (`@nifrajs/web/plugins/postcss`)** - runs `*.css` / `*.pcss` / `*.postcss` through PostCSS, feeding the result into the existing stylesheet pipeline (and the CSS-modules scoped-class transform for `*.module.*`). This is the Tailwind v4 path: a `postcss.config.js` with `@tailwindcss/postcss` compiles `app.css` importing `tailwindcss` at build time with no framework-specific code. `postcss` (and `postcss-load-config`, when you don't pass `plugins` explicitly) are optional peers, loaded lazily and failing loud with an install hint. Mirrors the SCSS plugin: pass `"dom"` for the client bundle, preload `"ssr"` for the server.

  - **`svgComponentBunPlugin` (`@nifrajs/web/plugins/svg`)** - import an SVG as a component, `import Icon from "./icon.svg?component"`, then `<Icon className="w-6 h-6" />` with props spread onto the root `<svg>` (the Vite `svgr` workflow). Emits an automatic-JSX-runtime component, so it works for React and Preact today; Solid/Svelte/Vue are out of this version. Optional `svgo` optimization. A plain `import "./icon.svg"` asset URL is untouched - only the `?component` marker is intercepted.

- a7d34e5: Navigation loading UI for `@nifrajs/web-react/router`, plus a per-link pending signal.

  nifra navigates imperatively - it fetches the next route's chunk and loader data while the current route stays on screen, then swaps - so a route transition is signalled by the router's `pending` flag, not a Suspense boundary.

  - `useNavigation()` returns `{ pending, state: "idle" | "loading", location }` (Remix-shaped); `location` is the `pathname + search` being navigated to while pending. `usePending()` is the boolean form.
  - `NavLink`'s render-prop `isPending` is now real: it is `true` while a navigation to that link's own target is in flight (matched like `isActive`), so a link can show its own spinner. Previously always `false`.
  - The agnostic router now publishes `pendingPath` (the navigation target) on its state while `pending`, and `compose` threads `pending`/`pendingPath` into the router context. Both are `false`/absent on the server and the initial client render, so they are hydration-safe.

### Patch Changes

- ade0c7a: Add a curated `@nifrajs/core/server` entry for the common HTTP runtime and dedicated subpaths for
  contracts, classification, cookies, logging, routing, Standard Schema, SEO, SSE, and webhooks. The
  package root remains backwards compatible, while new scaffolds and first-party runtime packages avoid
  eagerly parsing opt-in causality, invariant, manifest, reflection, capability, and assurance tooling.
- Updated dependencies [a7b1d60]
- Updated dependencies [eaac3d7]
- Updated dependencies [ade0c7a]
- Updated dependencies [82676e0]
- Updated dependencies [1522d06]
- Updated dependencies [a7b1d60]
- Updated dependencies [a7b1d60]
  - @nifrajs/core@2.0.0

## 1.13.0

### Minor Changes

- 5b6127a: Make route batches atomic, seal server configuration after `listen()`, encode array query values as
  repeated keys, and align web route matching with the server.

  Three behavior changes to know about:

  - **Configuring a server after `listen()` now throws** instead of reaching some traffic and not the
    rest. Bun's native route table is compiled when you listen, so a hook added afterwards applied to
    `app.fetch()` but not to real HTTP requests: an `onRequest` guard installed late was silently
    skipped on the wire. Register routes, hooks, plugins, and context before listening.
  - **Array query values serialize as repeated keys** (`?tag=a&tag=b`), not `?tag=a%2Cb`, so a route
    whose `query` schema declares an array now receives one.
  - **The web matcher applies the server's trailing-slash rule.** `/users/7/` no longer matches
    `/users/:id` in the browser, matching the 404 the server already returns, and a malformed percent
    encoding reports no route instead of throwing.

  A route batch from `implement()` or `merge()` commits only once every route in it validates, so a
  collision partway through leaves matching and reflection untouched instead of stranding the routes
  registered before it.

  Each route now owns one immutable compiled execution plan shared by portable, Node-direct, and
  Bun-native dispatch. This also fixes validation recovery being skipped when a derive moved a route
  from a specialized lane to the generic lifecycle.

  Core, browser navigation, Bun-native parameter metadata, and mock routing now consume the same
  compiled pattern kernel. Static routes beat parameters and parameters beat wildcards regardless of
  manifest order, with one grammar, trailing-slash policy, and malformed-encoding rule.

### Patch Changes

- Updated dependencies [aae8614]
- Updated dependencies [5b6127a]
  - @nifrajs/core@1.13.0

## 1.12.0

### Patch Changes

- Updated dependencies [63d3845]
- Updated dependencies [246f498]
  - @nifrajs/core@1.12.0

## 1.11.0

### Minor Changes

- 5638ada: Add an explicit symbol-keyed in-process backend mount interface. `inProcessClient` implements the
  interface and `createWebApp` forwards the outer request's platform context through it, so an
  auto-mounted backend receives the same Workers `env` bindings and `waitUntil` lifetime as the web app.

  The released `.fetch(url, init)` duck-typed mount remains as a compatibility fallback for custom
  bridges. `Server.onRequest` now receives the optional platform object as its second argument.

### Patch Changes

- Updated dependencies [2dde7e5]
- Updated dependencies [279f80c]
- Updated dependencies [5638ada]
- Updated dependencies [279f80c]
  - @nifrajs/core@1.11.0

## 1.10.0

### Patch Changes

- Updated dependencies [92181be]
- Updated dependencies [3773f0a]
- Updated dependencies [92181be]
  - @nifrajs/core@1.10.0

## 1.9.1

### Patch Changes

- 3eb27ae: Internal tidy - remove a dead local variable in the query engine and clean up example wording in doc comments. No API or behavior change.
  - @nifrajs/core@1.9.1

## 1.9.0

### Minor Changes

- 0e1b4cc: Add a full React Query core on `@nifrajs/web-react/query` - `useQuery` (now with `enabled`/`staleTime`),
  `useMutation`, `useInfiniteQuery`, `useQueryClient`, `QueryClientProvider`, and the SSR
  `HydrationBoundary` - a drop-in for the TanStack Query surface, backed by an expanded agnostic engine in
  `@nifrajs/web`.

  The engine (`createQueryClient`) gains imperative cache ops (`getQueryData`/`setQueryData` for optimistic
  updates, `prefetchQuery`), per-query `staleTime`, SSR `dehydrate`/`hydrate`, and paged (`infiniteQuery`)
  support; plus a standalone `createMutation` state machine (single-flight, TanStack callback order). All
  logic lives in the injected-clock, framework-free engine so it's deterministically tested; the React
  bindings are thin `useSyncExternalStore` wrappers. A hook without a `QueryClientProvider` uses a
  client-side singleton (SSR-idle); with a `HydrationBoundary`-fed provider client, queries render their
  server-seeded data during SSR with no hydration flash.

- 6b67833: Add first-class React routing bindings on the new `@nifrajs/web-react/router` subpath - `<Link>`,
  `<NavLink>`, `useNavigate`, `useParams`, `useLocation`, `useSearchParams`, and `<Navigate>` - a
  drop-in replacement for `react-router-dom`'s routing surface over nifra's own file-based router.

  The read hooks are SSR-correct: `@nifrajs/web` now threads the matched route's `params` and the
  request `path` (`pathname + search`) through the render seam (`RenderProps`), and the React adapter's
  `compose` provides them via a `RouterContext` on both the server render and the client mount - so
  `useParams`/`useLocation`/`useSearchParams` return the same value on each side with no hydration
  mismatch. Programmatic navigation flows through a new DOM-free bridge (`getBrowserNavigate` /
  `setBrowserNavigate`, populated by `installHistory`), which also gains history `replace` support, so a
  route component reaches history-aware navigation without importing the browser-only client layer.

### Patch Changes

- Updated dependencies [03cd76f]
- Updated dependencies [03cd76f]
  - @nifrajs/core@1.9.0

## 1.8.0

### Patch Changes

- 1ffd48b: fix(web): the static/client build no longer ships the generated `_nifra-entry.ts` source. `buildClient`
  wrote the client-entry source into the output dir purely as a `Bun.build` entrypoint but never removed it
  after bundling - so `nifra build --target static` leaked the TypeScript source next to the content-hashed
  `_nifra-entry-<hash>.js` the HTML actually references. It's now deleted once the client bundle succeeds; a
  static-build test asserts the `.ts` is absent from the output.
- Updated dependencies [e47c4c5]
  - @nifrajs/core@1.8.0

## 1.7.0

### Minor Changes

- 9f23e90: Fix `nifra build --target static` producing pages that render but never hydrate. The prerender pass hardcoded a placeholder client entry, but the real bundle is content-hashed - so the prerendered HTML's hydration `<script src>` 404'd and every control was inert. `BuildTargetOptions.prerenderApp` is now a factory `(client: BuildManifest) => app` invoked with the completed client build, so the emitted `<script src>` uses the real hashed entry (plus the same styles / route-preload the SSR targets use). A regression test asserts the static HTML references the emitted hashed entry and that the file exists under `/assets`. Breaking only for code calling `buildTarget("static", …)` directly (pass a factory instead of a prebuilt app); `nifra build --target static` users just get working hydration.

### Patch Changes

- Updated dependencies [bd95181]
  - @nifrajs/core@1.7.0

## 1.6.0

### Patch Changes

- @nifrajs/core@1.6.0

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

  A route's `RouteSchema` may now declare `errors` - a `{ status → Standard Schema }` map of its failure modes.
  Like `response`, it's a compile-time + introspection contract (not validated at runtime, zero hot-path cost):
  the declared error bodies flow into OpenAPI as non-2xx `responses` and into the `/llms.txt` context, so
  tooling and coding agents can read the _whole_ contract, not just the happy path.

  The **typed client** now surfaces them: on a failure `Result`, `data` is the parsed error body typed from the
  route's `errors` (a union across declared statuses; `unknown` when none declared), discriminated by `ok`.
  `error` remains the normalized `{ error, issues }` summary. The **decoupled contract client**
  (`client(contract, url)`) gets the same treatment - its failure `data` is typed from the op's non-2xx
  `responses` schemas.

  **Behavior change:** on failure, `data` is now the parsed error response body (previously always `null`) - so
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
  `normalizeRolldownPlugins` - which strips the stale `optimizeDeps.rollupOptions.jsx` key that Vite 8's
  rolldown dep-optimizer rejects - mapped over the outer array without flattening, so it never reached the
  inner `vite:react-babel` plugin that emits the key, and Vite (which flattens plugin arrays itself) then ran
  the un-stripped hook. It now flattens first, so the strip reaches every plugin and the harmless-but-noisy
  `Warning: Invalid input options … "jsx" Invalid key: Expected never but received "jsx"` is gone. No
  behavior change - JSX transform, HMR, and Fast Refresh are unaffected.

  - @nifrajs/core@1.2.1

## 1.2.0

### Patch Changes

- Updated dependencies [0ac2182]
  - @nifrajs/core@1.2.0

## 1.1.0

### Minor Changes

- 37d2383: feat(web): `@nifrajs/web/forms` - typed form ↔ backend-schema binding

  `formFor<typeof backend, "/route">()` binds a form's field names and reads to the route's body schema at
  the type level, derived purely from `typeof backend`. `f.field("text")` (spread onto any framework's
  `<input>`) and `f.read(formData, "text")` are constrained to the body's keys - a typo, an orphan field,
  or a wrong route path becomes a COMPILE error (caught by `nifra check`) instead of a silent runtime
  empty. Framework-agnostic, dependency-free, no schema bundled into the client (the runtime is a trivial
  pass-through; all the work is in the types). It checks the field KEY, not its MEANING.

### Patch Changes

- @nifrajs/core@1.1.0

## 1.0.0

### Patch Changes

- f1f0e18: Context ergonomics, from beta feedback building on Nifra.

  - **`c.json(body, status?)` / `c.text(body, status?)`** - build a `Response` in one line; the second arg is a status number or a full `ResponseInit`, and it works whether you `return` or `throw` it. Ideal for an auth / rate-limit short-circuit from a `derive`/`beforeHandle`: `throw c.json({ error: "unauthorized" }, 401)` instead of `new Response(JSON.stringify(…), { status: 401, headers: … })`. (In a route's happy path keep returning a plain object so the typed client stays in sync.) Added as prototype methods - no per-request allocation.
  - **One name for the request across routes and loaders.** A route handler's `c.req` is now also `c.request`, and a page loader/action's `ctx.request` is now also `ctx.req` - fixing the `c.req`-vs-`ctx.request` mismatch that was easy to trip over.

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
  passes them to `createWebApp` - which already emits `<link rel="stylesheet">` in the SSR `<head>`. Previously the
  head carried the JS modulepreload but no stylesheet, so every built (non-dev) app rendered unstyled. `styles`
  and `routeStyles` are now always exported from the generated manifest (default empty), so hand-written server
  entries can `import { styles, routeStyles } from "./server-manifest"` and forward them too.
  - @nifrajs/core@0.1.0-beta.2
