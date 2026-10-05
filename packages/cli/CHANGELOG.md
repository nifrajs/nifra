# @nifrajs/cli

## 4.0.0

### Major Changes

- 214d674: feat(cli)!: `backend/app.ts` and `backend/framework.ts`, and `nifra migrate layout`

  The CLI reads the backend from `backend/app.ts` and the render adapter from `backend/framework.ts`.
  An app that still has a root `backend.ts` or `framework.ts` is refused with the command that moves it.

  `nifra migrate layout` moves an app onto the zoned layout: it splits each route into `x.tsx` and
  `x.backend.ts`, folds `_middleware.ts` into `_layout.backend.ts`, moves the root files under
  `backend/`, places every other module in `frontend/`, `backend/` or `shared/` by who imports it, and
  rewrites the imports. It is a dry run until `--write`, and it lists what it could not decide - a
  helper both halves need, a page that reads a server export at runtime, a path named in a string.

  `nifra check` holds source to the same zones the builds enforce, with the same classifier
  (`@nifrajs/web/zones`). NF-C004 follows browser code - a route's frontend half, `frontend/` and
  `shared/` - to Node and Bun built-ins, server packages, backend modules and the `backend-only` marker,
  naming the chain; a `*.fn.ts` module counts as its stub. NF-C028 reports a zoned file importing one in
  no zone, backend code importing frontend code, and shared code importing anything but shared code.
  NF-C029 reports browser code reading a private environment variable, honouring a literal
  `publicEnvPrefix` in `backend/framework.ts`. NF-C005 names the retired `@nifrajs/web/server-only` and
  `@nifrajs/web/plugins/vite-server-only` imports with their replacements. A route's `x.backend.ts` half
  counts as a route file for manifest drift (NF-C012), and NF-S002 grades severity by zone.

- 6c978a1: feat(cli)!: the deploy target lives in `nifra.config.ts`

  - `export const target = "node"` in `nifra.config.ts` is what `nifra build` emits without
    `--target` (still `bun` when neither is given). `nifra port` and `nifra doctor` read it before any
    script heuristic.
  - `nifra target` shows it; `nifra target <t>` switches it, rewriting only that line.
  - The Cloudflare Pages target is `cloudflare` in `nifra build --target`, `nifra port --target` and the
    config; `cf-pages` is refused with the new name.

### Minor Changes

- c3057ee: feat: AGENTS.md is the one copy of an app's agent guidance

  A scaffold and `nifra init-agents` write `AGENTS.md` plus a pointer to it for each agent:
  `CLAUDE.md` and `GEMINI.md` import it, `.cursor/rules/nifra.mdc` is an always-applied Cursor rule
  that attaches it, and `.github/copilot-instructions.md` names it. None of them carries guidance of its
  own, so they cannot drift apart. A web app's `AGENTS.md` gains a "Project structure" section on the
  frontend/backend zones the build enforces, and `nifra init-agents` appends it to an app with `routes/`.

- 4e31e3f: `nifra cdn-check <url>` checks a deployed page behind a CDN. It requests the page twice and once as a soft navigation, names the CDN (Cloudflare, Vercel or Fastly) from its status header, and reports whether the second request was served from cache. It fails, exiting 1, when `x-nifra-isr-*` headers reach the visitor or when a soft navigation is answered with the cached document, which is what a Cloudflare zone does without a Cache Rule bypassing requests that carry `x-nifra-data`. It also warns when CDN-only headers are visible or when browsers may keep the HTML. CLI only.
- 6902bac: fix(cli): `nifra check` follows a literal dynamic `import()` from browser code

  The backend-code check (NF-C004) treats `import("../lib/x")` with a string-literal specifier like a
  static import: from a page and through its local imports, down to backend code, a Node built-in, a
  known server package or a module marked `@nifrajs/web/backend-only`. The client build bundles a
  dynamic import's target as a lazy chunk, so these were build failures `nifra check` passed. Type
  positions (`typeof import("x")`, `import("x").Pool`) and computed specifiers are not followed. A
  removed package imported dynamically is reported too.

- d680264: feat(cli): `nifra check` reports route data without an output schema

  NF-C030 warns about a route backend half whose loader or action may return data without its
  `loaderOutput` or `actionOutput`. NF-C031 is an error for an output schema that names a sensitive
  field (`password`, `token`, `apiKey`, ...) without `t.declassified`.

- a4428b2: `nifra db` and the `nifra_db_schema`, `nifra_db_query` and `nifra_db_role` MCP tools read the development database an app declares as `devDatabase` in `nifra.config.ts`, SQLite or Postgres. `DATABASE_URL` is never read on its own.

  - `nifra db schema [<table>]` lists tables, row estimates, columns, keys and indexes. `nifra db query "<sql>"` runs one read-only SELECT, and `--explain [--analyze]` returns its plan. Queries are on for a declared database unless `query: false`; a Postgres host other than loopback, `*.localhost` or a unix socket needs `allowHosts`.
  - Each call runs in a fresh process that is killed at `timeoutMs` plus one second, so a runaway query or a crash comes back as a refusal with a stable `NIFRA_DB_*` code, a fix and a docs link.
  - A Postgres superuser, or a role that can reach server files, server programs or another database, is refused queries. `nifra db role` prints the SQL for a read-only role and runs none of it.
  - A query that reads a credential column (or one in `redactColumns`) in any form is refused with `NIFRA_DB_COLUMN_REFUSED`, unless `revealColumns` names it. Rows are capped by `maxRows` and `maxResultBytes`, values pass through the dev feed's redactor, and every answer is marked untrusted.
  - Each call is appended to `.nifra/db-audit.jsonl` (owner-only, rotated at 1 MB) with its redacted SQL, fingerprint, row count, duration and refusal code, never its rows. `nifra db audit` shows it.

- 8b99424: feat: `nifra errors`, `nifra logs` and their MCP tools read the running dev server

  `nifra errors` / `nifra_errors` and `nifra logs` / `nifra_logs` find the project's running
  `nifra dev` server without being given a port (its record, else the one live server among a
  workspace's apps), check that it answers as itself, and read what it recorded: errors as structured
  diagnostics with filters by category, request and staleness, and console output by level, source,
  request and text. Pass the returned `cursor` as `since` to see only what is new. When the server is
  gone they read the log it left behind, so a crash still leaves a record. `nifra errors` exits 1 while
  the current code has open errors. Every answer says that entry text is application output, to be
  read as data.

  `nifra_explain` no longer needs a port: with no pasted error it returns the latest error of any
  kind. `nifra_inspect` reads the dev server's own request traces (with a `requestId` filter), so it
  no longer needs the `@nifrajs/devtools` plugin, and falls back to it only for a port no record names.
  `nifra_run` results carry the console output and the structured errors each request produced.

- 20c05b2: `nifra i18n check` looks for its entry module at `shared/i18n.ts` first, where an app keeps the locales and catalogs both sides import.
- 595a4e3: feat(cli): `nifra init-agents` at a workspace root names its nifra member in the MCP launch. When the
  root is not itself a nifra project and exactly one workspace member is, the `.mcp.json` and
  `.cursor/mcp.json` it writes launch `mcp <member>`, and `--sync-mcp` adds the member to an existing
  launch that names no directory. A launch that already names one keeps it, the markdown launch commands
  keep their wording, and with several nifra members nothing is named. `--sync-mcp` also pins to the
  member's installed nifra when the root has none, as in an isolated install.
- 4acb99f: feat(cli): `nifra mcp` started at a package-manager workspace root serves its nifra app.
  When neither the spawn directory nor any ancestor is a nifra project, the server reads the spawn
  directory's `package.json` `workspaces` (the array form or `{ packages }`), and adopts the one member
  that depends on `@nifrajs/*` or has a `nifra.config.ts`. The root's source reads `workspace`. With
  several nifra members it adopts none, and project tools refuse with a message naming each member to
  pass to `nifra mcp <dir>`. A client workspace folder that is a workspace root offers its nifra member
  the same way. An explicit `nifra mcp <dir>` is never redirected, and `node_modules` is never a member.
- 505a5f4: `nifra migrate layout` also moves an app off the retired names and reports what the data guard needs:

  - each `x.server.ts` module moves under `backend/` without the suffix (`lib/db.server.ts` becomes
    `backend/lib/db.ts`), and every import of it is rewritten; one a route frontend still imports at
    runtime, or whose new path is taken, is reported instead;
  - `@nifrajs/web/server-only` imports become `@nifrajs/web/backend-only`, and `ServerOnly` imported from
    `@nifrajs/web` becomes `BackendOnly`;
  - an import of `@nifrajs/web/plugins/vite-server-only` is reported for removal;
  - a loader or action that returns data without `loaderOutput` / `actionOutput` is reported, since the
    server refuses that data.

- a8b33bc: `nifra check` reports an import of a name that moved to a package subpath under NF-C005, naming the module that exports it now, and `nifra fix --code NF-C005` rewrites the import - re-exports and aliases included. It covers `solidBunPlugin` (`@nifrajs/web-solid/plugin`) and `svelteBunPlugin` (`@nifrajs/web-svelte/plugin`).
- df9352a: `nifra_scaffold` returns a route pair: the page, typed through its generated `./+types` module, and
  its `.backend.ts` half with the loader and its `loaderOutput` schema. With `write`, it creates both
  files (refusing when either exists) and generates the route's types. Vanilla pages declare
  `hydrate = false` and their `islandScripts` in the backend half.
- 22e2af8: feat(cli): `nifra check` reports credentials in browser code

  NF-C032 is an error for what looks like a credential in a route's frontend half, `frontend/`,
  `shared/` or `public/`, with the scanner `nifra build` runs. `nifra build` reads `secretExemptions`
  from `nifra.config.ts`, and `nifra check` honors the same entries when they are written as literals.

- 046a1e1: feat(cli): `nifra upgrade` runs every release recipe between the installed version and the target

  The installed version is the lowest `@nifrajs/*`, `nifra` or `create-nifra` version the workspace
  declares. `nifra upgrade <version>` applies each release recipe after it, up to the target, oldest
  first - dependency moves, import moves and notes labeled by release - then pins the fixed group to the
  target, so a 1.x or 2.x app reaches the target in one run. Any version up to the CLI's own is a target.
  `--exact` pins exact versions instead of keeping `^`/`~`.

  A target newer than the CLI prints the command for that release's CLI
  (`bunx @nifrajs/cli@<version> upgrade <version>`, with the same flags) and changes nothing; a target
  that is not a bare release version is refused. The 4.0.0 recipe moves `@nifrajs/web/server-only`
  imports to `@nifrajs/web/backend-only`, leads with `nifra migrate layout`, and notes the changes an
  existing app may observe: the zoned layout, required output schemas, the credential scan, the
  `cloudflare` target name, `withISR` query bypass, pages under a mount failing at startup, exact method matching,
  resolved dot segments, JSON media-type matching, required endpoint secrets, the empty `clientEntry`
  error, typed-client dot-segment refusal, canonical base64url signatures and locale-formatted plural `#`.

- a0cfffa: `export const clientIp = "platform"` in `nifra.config.ts` makes a `cloudflare` or `vercel` build read `c.clientIp` from the header that platform's edge overwrites (`cf-connecting-ip`, `x-real-ip`), so per-caller middleware such as `rateLimit` works there. Without it an edge build still has no caller address; Bun, Node and Deno builds use the socket peer either way. `buildTarget` and `generateServerEntry` take the same `clientIp` option. Site scaffolds declare it.
- 93e5e7f: Errors come with a prompt to paste into a coding agent: the error, where it is, the recognised cause, one fix, and steps that end in a check the agent runs itself (`nifra_errors` with a `since` cursor, then `nifra check`). App-supplied text is fenced and labeled as data, paths are project-relative, the home directory never appears, and the prompt is capped at 8000 characters.

  - Codes with more than one right fix (`NIFRA_BACKEND_IN_CLIENT`, `NIFRA_BACKEND_ONLY_IN_CLIENT`, `NIFRA_OUTPUT_SENSITIVE_FIELD`, `NIFRA_OUTPUT_UNDECLARED_DEFERRED`, `NIFRA_OUTPUT_RAW_RESPONSE`, `NIFRA_OUTPUT_SCHEMA_MISMATCH`) list each as a labeled `fixOptions` entry on the `Diagnostic`, with one prompt per option.
  - The dev overlay has a Copy prompt button per fix. A page load whose render throws gets the overlay on both dev pipelines; data requests and API calls keep the app's JSON 500.
  - A dev page that reports a browser error shows a badge listing that page's errors with their code, message, codeframe, fix and Copy prompt buttons. It renders in a closed shadow root, loads under the page's CSP (nonce, exact URL, or `'strict-dynamic'`), is only fetched once a page errors, and turns off with `nifra dev --no-indicator`, `export const dev = { indicator: false }` in `nifra.config.ts`, or `indicator: false` on `createDevServer`/`createViteDevServer`.
  - `nifra errors --prompt` (and `nifra_errors` with `prompt: true`) prints the prompt for the newest entry; `--id` picks an entry and `--option` picks a fix by its label.
  - `@nifrajs/web/diagnostic-prompt` exports `buildFixPrompt`, `fixPrompts` and `catalogFixPrompts` without Node APIs, for use in a browser bundle.

- 772249a: feat(i18n): catalog checks - `checkCatalogs()` and `nifra i18n check`

  `checkCatalogs({ locales, catalogs, ignore })` from the new `@nifrajs/i18n/check` entry checks every
  catalog in a locale registry the way `t()` reads it: coverage per locale (counting messages inherited
  through `chain()`), missing keys and keys the default catalog does not have, ICU syntax,
  placeholder and rich-tag parity with the default message, a missing `other` case, plural categories
  the locale's grammar uses that a message never states, script purity (letters outside
  `Intl.Locale(tag).maximize().script`, and, as a warning, words mixing Latin with it), and messages identical to the
  default in another language. It returns findings with a severity (`error`, `warning`, `info`) and a
  per-locale coverage table; `ignore` skips keys per check.

  `nifra i18n check [entry]` imports the module exporting `locales` and `catalogs` (the first
  `i18n.ts` in the project root, `lib/`, `src/`, `src/lib/` or `app/` by default; catalogs may be
  lazy loaders such as `() => import("./fr.json")`) and prints the report. It exits 1 on an error, and
  with `--strict` on a warning; `--json` prints the result.

- ff4a062: feat(core): one handler can be registered under several methods, and under a method outside the
  standard seven, with `all()` and `method()` from `@nifrajs/core/methods`:

  ```ts
  import { server } from "@nifrajs/core/server";
  import { all, method } from "@nifrajs/core/methods";

  const app = server()
    // GET, POST, PUT, PATCH, DELETE, HEAD and OPTIONS /echo
    .use(all("/echo", (c) => ({ method: c.req.method })))
    .use(method("PURGE", "/cache/:key", (c) => ({ purged: c.params.key })))
    .use(method(["GET", "POST"], "/search", (c) => ({ q: c.query.get("q") })));
  ```

  - Each method is an ordinary route: it is listed by `app.routes()`, takes a schema and hooks, works
    inside `group()`, and throws `DUPLICATE_ROUTE` against a route already registered for the same
    method and path. One call is one registration: if any of its routes is refused, none is added.
  - `all()` is the seven standard methods, not a catch-all. A request with any other method is still a
    `405` with an `Allow` header. `mount()` remains the way to pass every method through.
  - A method name is case-insensitive and registered uppercase. It is a token of letters, digits and
    hyphens that starts with a letter, at most 32 characters. `TRACE`, `CONNECT` and `TRACK` cannot be
    registered; those and any other value throw `INVALID_METHOD`.
  - The standard methods in a call join the typed registry and the typed client. A custom method has
    no typed-client call.
  - An assurance policy's `methods` selector takes standard methods only, so it never matches a
    custom-method route. Classify such a route with a path rule; unmatched, it is reported as
    `unclassified-route`.
  - Whether a custom method reaches the app is up to the runtime's HTTP parser: `PROPFIND`, `REPORT`,
    `PURGE` and `QUERY` arrive on Bun, Node, Deno and workerd, and a token the parser does not know
    can be answered by the runtime itself.
  - `Router.add` from `@nifrajs/core/router` accepts the same method tokens, and
    `isRegistrableMethod(name)` from that subpath reports whether a name is one.
    `RouteDescriptor.method` is typed `RouteMethod`: a standard `Method` or another such token.

  feat(schema): `toOpenAPI` leaves a custom-method route out of the document. A path item has a field
  for each standard method and none for any other.

  feat(cli): `nifra check` reads the routes `all()` and `method()` register, so the duplicate,
  overlap, reserved-segment and param-modifier rules cover them, reported once per call. The route
  brief and `--json` output list a custom-method route with a `fetch` call. The capability report
  attributes a module to every path an optional-param route serves, and to `all()` and `method()`
  routes.

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
- 28f3aaf: feat(core): a path can end in optional params, written `:name?`. The route serves the path with the
  param and without it:

  ```ts
  app
    // GET /users and GET /users/42
    .get("/users/:id?", (c) =>
      c.params.id === undefined ? { all: true } : { id: c.params.id }
    )
    // GET /archive, GET /archive/2026 and GET /archive/2026/09
    .get("/archive/:year?/:month?", (c) => ({
      year: c.params.year,
      month: c.params.month,
    }));
  ```

  - Optional params are whole segments at the end of the path. Several in a row are filled left to
    right: a later one is present only when every earlier one is. A `?` anywhere else (`/a/:id?/b`,
    `/v-:id?`) is literal text, as before.
  - An optional param is typed `string | undefined`. When the path omits it, it is absent from
    `c.params`, not an empty string. A `params` schema that requires it answers `422` on the shorter
    path.
  - The route is registered once per path it serves, with the same handler, schema and hooks.
    `app.routes()`, `group()`, `merge()`, `implement()`, `ws()` and the typed registry all see those
    paths, so `GET /users` registered next to `GET /users/:id?` throws `DUPLICATE_ROUTE`. A route that
    is rejected leaves none of its HTTP paths registered.
  - The typed client calls each path: `api.users.get()` and `api.users({ id }).get()`.
  - `defineContract` accepts the same paths; two operations that serve the same method and path are
    refused.
  - `expandOptionalParams(pattern)` from `@nifrajs/core/pattern` returns the paths a pattern serves,
    shortest first. `Router.add` from `@nifrajs/core/router` registers exactly the pattern it is given;
    a caller that wants the optional form adds each expanded pattern.
  - `routePatternOverlap` compares every path each side serves, under one work budget for the call.

  feat(edge): the compact server accepts the same optional params.

  feat(schema): `toOpenAPI` emits one operation per path an optional-param route serves. A shorter
  path declares only the parameters it has. For a contract, the operation name is the `operationId` of
  the full path, and the shorter paths carry none.

  feat(cli): `nifra check` reports `NF-C026` (warning) for a param followed by `?`, `*`, `+`, `{`, `(`
  or `<` that the path grammar reads as literal text, and names a `?` route that no request can reach.
  `// nifra-expect param-modifier` above the registration marks a deliberate literal. Overlap and
  duplicate checks read an optional-param route as every path it serves.

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

- 52bb49e: Support TypeScript 5, 6, and 7 in Nifra's syntax and response-reflection scanners. TypeScript 7 projects use its unstable AST and asynchronous project APIs through a shared compatibility session, with unsupported compiler majors failing closed.
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

### Patch Changes

- f96196f: `nifra dev` on the Bun pipeline applies the `define` from `nifra.config.ts` to the browser bundle and to server rendering, as `nifra build` does. Vue's feature flags reach the dev client, so the "Feature flags ... are not explicitly defined" warning no longer appears. A config `define` entry wins over the same name in the app's own `bunfig.toml`, and a value that is not a string is refused by name.
- 20c05b2: `nifra check` reports its import finding as "backend code in browser code", and `nifra_frontend` and `nifra_learn` point at the route's `.backend.ts` half for loaders, actions and their output schemas.
- 736fae8: `nifra check` treats a value re-export (`export { x } from "y"`, `export * from "y"`, `export * as ns from "y"`) as an import edge, the way a bundler does. The server-only import scan, its transitive chain through barrel files, and the zone import check (NF-C028) now follow re-exports. `export type …` re-exports, and with a TypeScript install an all-type named re-export, are skipped as before.
- a5cf1c3: `nifra check` on a project using TypeScript 7 completes when it follows an import into a module outside the scanned set, such as a `.js` helper with its own imports. Previously the whole check stopped with "TypeScript 7 source file was not preloaded". The import scan reads such a module with its lexical rule. For the SQL scan, such a module proves no constant, the same as a module that does not parse.
- 2ed4c59: `nifra_run`, `nifra_render`, `nifra_ws`, `nifra_test`, the `nifra check` typecheck and the `nifra fix` rebuild and codemod start their child processes with the Bun that runs nifra, not the first `bun` on `PATH`. An MCP client that starts `nifra mcp` with a minimal `PATH` no longer breaks them, and a `bun` shim earlier on `PATH` is never picked up.
- 8b8dde2: `nifra contracts snapshot` writes `contracts.lock.json` routes, and `nifra sdk` emits operations, in code-unit order instead of `localeCompare` order, so the files a project commits come out the same on every machine. A lock or SDK whose routes the two orders rank differently (mixed case, `-` beside `_`) is reordered once when it is next written; `nifra contracts check` compares routes by key and is unaffected.
- 8739624: The contracts lock digest covers schema properties named `title`, `description`, `default`, `example` or `examples`, and the instance data inside `enum` and `const`. Those annotation keywords on a schema itself still do not count as a contract change. A lock written by an earlier release reports each route with such a property as changed once; review it and run `nifra contracts snapshot`.
- cc3e0fa: The contracts lock digest covers a schema property named `__proto__`, so `nifra contracts check` reports a change to that property's schema.
- 20c05b2: `nifra_docs`, `nifra_example` and `nifra_types` match a camelCase heading by its whole word as well as its parts, so a `websocket` query finds the WebSockets section by name.
- f23d036: `nifra doctor --fix` re-points a path dependency it copies from an ancestor `package.json` (`file:`, `link:`, `portal:`, or `./`/`../` specs) so the copy names the same directory from the package being fixed. Previously the spec was copied unchanged and resolved against the wrong directory. Version ranges and `workspace:` specs are copied as before.
- 612fdfe: `nifra_explain` shows a codeframe only from project source files. A stack frame naming a dotfile or anything under a dot directory, such as `.env` or `.git/config`, gets no source excerpt.
- 0e622ae: NF-S001 reads a gate written as an arrow or function expression by the name it is bound to, such as `const requireAuth = async () => …` or `{ canEdit: () => … }`, so a fail-open catch in one is reported like one in a function declaration.
- d90e509: fix(cli): the `nifra_gallery` MCP tool declares itself non-destructive and idempotent in its
  annotations, so clients that gate tool calls on those hints run it without asking.
- 8a2e7e5: fix(cli): `nifra assure --hydration` hydrates every route in its DOM run and fails when hydration does
  not happen. With `happy-dom` installed, the run could not load a code-split client entry, imported
  the entry only once (so routes after the first were never hydrated), and checked the page before the
  framework had hydrated it. It now builds the entry so its chunks load from disk, gives each route its
  own copy, waits for the document's `data-nifra-hydrated` marker (up to 5s) and reports a route that
  never gets there. An error the client throws while hydrating is reported too. The page data comes
  only from the document's handover, as in a browser, and framework runtimes get the DOM globals they
  use (Vue's `SVGElement`).
- d1e82be: The hydration gate (`nifra assure --hydration`, `nifra_hydrate`, hydration replays) no longer reports a false NF-H001 when a project's config or loader prints to stdout: the runner's answer travels on its own tagged line, and `console.log` output from project code goes to stderr. A run now stops after five minutes, `nifra_hydrate` stops when the MCP call is cancelled, and the runner's output is bounded.
- 3e7cb83: The import scanners behind `nifra check`, `nifra doctor` and the capability provenance check read an import or re-export clause by its grammar: a default binding, then `* as name` or a `{ … }` list. Previously they scanned lazily to the next `from`. A long module with many `export const` lines and no string literal now scans in linear time; 16,000 lines took over 4 seconds before. Each re-export is attributed to its own line, and minified `import{a}from"x"` is read too.
- d2e392a: feat(cli): `nifra init-agents --sync-mcp` re-pins the `@nifrajs/cli@x.y.z` MCP launch in `.mcp.json`,
  `.cursor/mcp.json`, `CLAUDE.md` and the `## MCP server` section of `AGENTS.md` to the nifra the
  project installs. Only the version changes; every other byte stays as it is, no file is created, and
  a second run is a no-op. The CLI-version drift warnings from `nifra mcp` and `nifra doctor` recommend
  it, `nifra doctor` flags a stale pin even when the CLI itself matches, and a plain `nifra init-agents`
  run points any kept file with a stale pin at the flag.
- a84f546: `nifra verify --release` runs the leak matrix (`bun run check:leak-matrix`): every way server code or a
  credential can reach a browser, against both bundlers, both dev servers, the server build, each
  framework's route syntax and each deploy target's output.
- 9fc5ef3: `nifra manifest emit --sign <keyId>` is available only from the CLI. The `nifra_manifest` MCP tool no longer lists `sign` in its input schema and answers a call that passes it with `{ ok: false, error: "sign is available only from the nifra CLI" }`, so an agent cannot ask the operator's `manifest.signer` callback to sign a manifest. Commands declare such fields with the new `cliOnlyFields` on their spec; the catalog entry carries them, and `commandMcpInputSchema()` gives the schema an MCP tool advertises.
- 0140def: `nifra_run` and `nifra_ws` return as soon as the answer is written. An app that keeps a handle open at load, such as a database pool or an interval, made each call wait out the 30-second child timeout.
- 6745d2a: `nifra mcp` runs no project code in its own process and keeps none of the project's `.env`. The tools that load the app (`nifra_context`, `nifra_routes`, `nifra_check`, `nifra_openapi` and the rest), the routes and OpenAPI resources, and the tools, resources and prompts the app declares on its backend run in a fresh subprocess per call, started in the project's directory. Each call sees the project's current code and its `.env`, wherever the client started the server, and a config or backend that exits or hangs fails only that call. `nifra_run`, `nifra_render`, `nifra_ws` and `nifra_hydrate` also start their processes in the project's directory. A server that Bun started with `.env` values serves from a copy of itself that never loads them; values set in the environment and `--env-file` values are kept. In a monorepo, each app's tools see that app's `.env` and no longer the root's; to share values across apps, set them in the environment or pass `--env-file`. A call that loads the app costs one process start, tens of milliseconds, more when the config imports heavy plugins.
- 3c70d9c: `nifra mcp --env-file <path>` values now reach the processes its tools start: `nifra_run` (one-off and `warm`), `nifra_render`, `nifra_ws`, `nifra_hydrate`, `nifra_test` and the `nifra_db_*` tools see them, as the app's own tools and the tools that load the app do.
- 429eff5: `nifra_run` and `nifra_render` with `warm: true` reuse one hot worker for the whole MCP session, as documented, instead of starting a new one per call. The source fingerprint that restarts the worker on a change no longer walks `node_modules`, build output or dot directories.
- ed12674: `nifra openapi` works on an API-only app: with no `nifra.config.ts` or `backend/framework.ts`, it reads `backend/app.ts` alone instead of asking for a UI adapter.
- c224eda: `nifra review --diff` no longer passes a change while the project has a type error in a file outside the diff. A change can break a caller it never touched, so the `typecheck` check reports `unavailable` with reason `filtered-out-of-scope` and the review is `inconclusive`. The text report names the reason next to each unavailable check.
- 58c092b: `nifra sdk` generates the client for a backend whose routes it reads from `backend/app.ts`, instead
  of failing before it writes anything.
- 82f2e7d: `nifra sdk --lang go` writes a property's JSON name into a struct tag only when Go's `encoding/json` can read it there. A property name with a quote, backslash, backtick, comma or control character has no struct-tag spelling. Such a field is left out and reported like any other unsupported schema, and `--strict` refuses the document. A property named `-` is tagged `json:"-,"`, so it is no longer dropped.
- 7911e4a: NF-S002 flags a comparison against a secret read from configuration: an `UPPER_SNAKE` member such as `process.env.API_TOKEN` or `env.WEBHOOK_SECRET`, and a string-keyed read such as `process.env["API_KEY"]`. PascalCase enum members such as `ts.SyntaxKind.PlusToken` stay unflagged.
- c8a345d: `nifra check` reads every `secretExemptions` entry in `nifra.config.ts` when a string in it holds a bracket, brace or colon, such as the file `routes/[lang]/index.tsx`, instead of dropping that entry and the ones after it.
- bc73e9c: `nifra_test` keeps `pattern` inside the selected project. A pattern that resolves outside it, by `../`, an absolute path or a symlink, is refused before `bun test` starts.
- c4567cf: `nifra_test` keeps only the first 4,000 and last 8,000 characters of a test run's output as it reads, instead of holding all of it before trimming, so a run that prints hundreds of megabytes no longer grows the MCP server's memory with it. When output was dropped, the result marks where and how many bytes were left out.
- e8df2af: `nifra fix --code NF-S002` rewrites every flagged comparison in a file in one pass, found from the syntax tree rather than the reported line. A file with several comparisons, a property operand such as `headers.signature`, or a `"use server"` directive now comes out correct, and an existing `timingSafeEqual` import no longer collides with the added helper.
- e414818: `nifra check` parses a `.ts`, `.mts`, or `.cts` file as TypeScript instead of TSX in its SQL interpolation scan, security rules, nano and island lints, and route source facts. A generic arrow (`<T>(items: T[]) => ...`) or an angle-bracket cast in such a file no longer makes the file unparsable or hides the code after it from those checks, so findings they missed there now appear.
- 0fb7a13: `nifra check`'s typed-client rewrite for a simple own-API `fetch` appends a path segment the client reserves (`get`, `post`, `options`, `index`, `then` and the rest) with a call, as in `api.blog("post").get()`, so the suggested code reaches the route. Previously it suggested `api.blog.post.get()`, which the client cannot resolve.
- 88178b4: `nifra upgrade`:

  - Removing a dependency whose successor is already declared keeps `package.json` valid when the removed entry is the last one in its block. An edit that would leave a manifest unparseable is not written.
  - `dist/`, `build/` and `coverage/` directories at the workspace root are skipped like nested ones, so build output and coverage reports are no longer rewritten.

- 38cf032: `nifra build` for the `vercel` target writes to `.vercel/output`, where `vercel deploy --prebuilt`
  reads it, unless `--out` names another directory.
- 19f1c8b: `nifra verify` and `nifra_verify` report a gate whose `package.json` script the project does not declare as `undeclared` instead of running it and failing. A project that declares `lint` and `test` gets those two gates run and the rest listed as not declared; the run passes when every gate that ran passed, and fails when none ran.
- 3734451: The verification work graph behind `nifra prove` (`nifra_prove`):

  - `.svelte`, `.vue`, `.mdx` and `.css` files are app source. An edit to one after the last build makes the build stale, and each file is a node of the graph.
  - A changed file under `routes/`, `frontend/`, `backend/` or `shared/` that the graph does not model, such as a deleted module, impacts every route and needs proof. Previously the plan was empty and the change was reported as done.

- 4801cac: `diffNifraManifests` and `nifra manifest diff` diff a route that is new in the candidate manifest against an empty route. The capabilities it declares are reported as added and breaking, and a `pii` or `secret` response classification as an increase that is breaking, the same as when an existing route makes that change. A new route that declares no capability and returns public data is still only an added route.
- ef28ef9: CLI output that lists routes, files, findings or packages - `nifra routes`, `nifra doctor`, `nifra check`, `nifra port`, `nifra manifest`, `nifra sync-manifest`, `nifra graph`, `nifra types` and the generated SDK - is ordered by code unit, so it comes out the same on every machine and in every locale.
- 9ccf198: `handleRpc` takes `exposeToolErrors`, which answers a throwing tool with `Tool execution failed: <message>` instead of the bare text. It is off by default, so a remote caller still sees nothing from an error message. `nifra mcp` turns it on for its stdio server, so the local agent sees why a project tool failed, for example the error that stopped the backend from loading.
- 0d8d426: fix(cli): `nifra mcp` no longer answers for a different nifra release than the project installs. When
  the project has its own `@nifrajs/cli` at another version, the server hands the stdio session to the
  project's `node_modules/.bin/nifra mcp` (passing an explicit project dir through). When that is
  impossible - no project CLI, no linked bin, or a hand-off that still disagrees - `nifra_check`,
  `nifra_types`, `nifra_docs`, `nifra_example`, `nifra_assure` and `nifra_contracts` fail with the
  version split and the command that fixes it, while release-independent tools keep working.
- ff87ed3: `nifra migrate layout` finds an SFC's script blocks however their closing tag is spaced (`</script >`).
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

- dc2d4d3: fix(cli): duplicate-install findings name a copy reached through a symlink out of its install

  When an importer reaches a copy of an identity-sensitive package through a symlink that points
  outside its own install (another project's `node_modules` linked into a shared package, or a
  `bun link`), `nifra doctor` prints a `links:` line with each link and its target, and the
  `nifra check` duplicate-install diagnostic names the link on that copy and lists it ahead of both
  fixes. The identity preflight carries it as `copies[].links` and `provenance`. Package-manager store
  links inside an install are not reported.

- d1e2f50: feat: starters type their routes with the generated `./+types`

  The site and ISR starters type the landing page as `import type { Route } from "./+types/index"`:
  `props: Route.ComponentProps` in the page, `Route.LoaderArgs` / `Route.ActionArgs` in its backend
  half. `data` is the `loaderOutput` schema's type, which is what reaches the browser. A scaffold
  ships its `.nifra/types`, so the types resolve right after `bun install`, before any nifra command
  has run. The Svelte starter types its `$props()` the same way, and the Vue starter types the props it
  declares from `Route`. Svelte and Vue scaffolds include their `.svelte` / `.vue` files in
  `tsconfig.json`, so svelte-check, vue-tsc and the editor type-check routes. `nifra_frontend`'s
  loader-typing guidance now points at the route types.

- 562b4af: fix(client): a `.` or `..` param value is refused instead of sent

  A URL reads a `.` or `..` path segment as a step to another path, in every encoding, so
  `api.users({ id: ".." }).delete()` was a request for `DELETE /`, not for a user named `..`.

  - A call whose path has a `.` or `..` segment sends nothing and resolves to
    `{ ok: false, status: 0, data: null, error: { error: "invalid_path" } }` - the shape a network
    failure takes. No `onRequest` hook runs and nothing is retried.
  - `.subscribe()` reports `invalid_path` through `onError`, then closes. `.ws()` throws before a
    socket is opened.
  - `inProcessClient` and `testClient` behave the same way.
  - Values that only contain dots (`a.b`, `...`, `.hidden`) and a wildcard value such as `a/../b`
    (sent as one encoded segment) are unaffected.
  - The Python and Go clients from `nifra sdk` refuse the same values: Python raises `ValueError`,
    Go returns an error.

  Validate a param where it is read: a `.` or `..` sent by another client still reaches the route
  as the param's value.

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

- Updated dependencies [a8b33bc]
- Updated dependencies [c3057ee]
- Updated dependencies [dde125b]
- Updated dependencies [22e2af8]
- Updated dependencies [72b62fa]
- Updated dependencies [aa44e93]
- Updated dependencies [4a3ee60]
- Updated dependencies [963694f]
- Updated dependencies [57356c0]
- Updated dependencies [682d8bf]
- Updated dependencies [4ab5c6a]
- Updated dependencies [bd6786e]
- Updated dependencies [a0cfffa]
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
- Updated dependencies [6ce7975]
- Updated dependencies [5f1f3d8]
- Updated dependencies [6c978a1]
- Updated dependencies [7669f56]
- Updated dependencies [a77b341]
- Updated dependencies [ce169a2]
- Updated dependencies [b83d400]
- Updated dependencies [214d674]
- Updated dependencies [a0cfffa]
- Updated dependencies [d7892ea]
- Updated dependencies [93e5e7f]
- Updated dependencies [214d674]
- Updated dependencies [4936309]
- Updated dependencies [ff5a779]
- Updated dependencies [772249a]
- Updated dependencies [f70f99b]
- Updated dependencies [49f106f]
- Updated dependencies [4936309]
- Updated dependencies [0e9b167]
- Updated dependencies [bbdc5a1]
- Updated dependencies [10bc446]
- Updated dependencies [e8270d9]
- Updated dependencies [d942c33]
- Updated dependencies [ef28ef9]
- Updated dependencies [ef28ef9]
- Updated dependencies [d4d40a5]
- Updated dependencies [37dff1d]
- Updated dependencies [d4a79de]
- Updated dependencies [9ccf198]
- Updated dependencies [ff4a062]
- Updated dependencies [29c6c94]
- Updated dependencies [43ba944]
- Updated dependencies [46c741a]
- Updated dependencies [7bfa25e]
- Updated dependencies [216fe27]
- Updated dependencies [52bb49e]
- Updated dependencies [4936309]
- Updated dependencies [6e257a6]
- Updated dependencies [4a03d30]
- Updated dependencies [8e30090]
- Updated dependencies [28f3aaf]
- Updated dependencies [6d20355]
- Updated dependencies [08250bf]
- Updated dependencies [6907cbe]
- Updated dependencies [4b8d8de]
- Updated dependencies [ba5dd1c]
- Updated dependencies [d50f73e]
- Updated dependencies [031c33d]
- Updated dependencies [4936309]
- Updated dependencies [fb7c5b3]
- Updated dependencies [715186c]
- Updated dependencies [4b8d8de]
- Updated dependencies [f56b6a8]
- Updated dependencies [8fa902c]
- Updated dependencies [085e852]
- Updated dependencies [b64c3ee]
- Updated dependencies [dc2d4d3]
- Updated dependencies [d1e2f50]
- Updated dependencies [784d772]
- Updated dependencies [af7648c]
- Updated dependencies [fab1d24]
- Updated dependencies [1afbe9f]
- Updated dependencies [bda9637]
- Updated dependencies [562b4af]
- Updated dependencies [81c720e]
- Updated dependencies [ed60b23]
- Updated dependencies [0150ed4]
- Updated dependencies [ae815ab]
- Updated dependencies [ea2ee87]
- Updated dependencies [3442e1c]
- Updated dependencies [85d636b]
- Updated dependencies [6c978a1]
- Updated dependencies [bfe29b6]
- Updated dependencies [8b99424]
- Updated dependencies [87783f0]
- Updated dependencies [135aba4]
- Updated dependencies [47b0d65]
- Updated dependencies [e32268d]
- Updated dependencies [432fec3]
- Updated dependencies [0e14068]
- Updated dependencies [8f1b780]
- Updated dependencies [dcc9ff6]
- Updated dependencies [5a63dd4]
- Updated dependencies [c49882f]
- Updated dependencies [dfd19d8]
- Updated dependencies [28e091f]
- Updated dependencies [046e79d]
- Updated dependencies [6393b1e]
- Updated dependencies [a158b74]
- Updated dependencies [ee19d29]
- Updated dependencies [293d3c8]
- Updated dependencies [7e1e1c3]
- Updated dependencies [0cd5f6e]
- Updated dependencies [2245bee]
- Updated dependencies [feeec4a]
- Updated dependencies [3eb6339]
- Updated dependencies [f784c32]
- Updated dependencies [e3b2b97]
- Updated dependencies [5934b5d]
- Updated dependencies [03a3729]
- Updated dependencies [bd11269]
- Updated dependencies [579d9a9]
- Updated dependencies [3554ad8]
- Updated dependencies [64e7a42]
- Updated dependencies [ee19d29]
- Updated dependencies [d6f806f]
- Updated dependencies [38cf032]
- Updated dependencies [b94e5cb]
- Updated dependencies [0f6babe]
- Updated dependencies [00f18bf]
- Updated dependencies [a84f546]
- Updated dependencies [ff25d68]
  - create-nifra@4.0.0
  - @nifrajs/core@4.0.0
  - @nifrajs/schema@4.0.0
  - @nifrajs/web@4.0.0
  - @nifrajs/client@4.0.0
  - @nifrajs/i18n@4.0.0
  - @nifrajs/testing@4.0.0
  - @nifrajs/mcp@4.0.0
  - @nifrajs/mcp-db@4.0.0
  - @nifrajs/runner@4.0.0
  - @nifrajs/agent-review@4.0.0

## 3.5.0

### Patch Changes

- 6430334: Add the provider-neutral, content-free review report contract and expose `nifra review` through the CLI, authenticated agent RPC, and Workbench-safe view projections.
- Updated dependencies [6046984]
- Updated dependencies [ac27343]
- Updated dependencies [d5b7c22]
- Updated dependencies [6430334]
- Updated dependencies [82c3018]
  - @nifrajs/core@3.5.0
  - @nifrajs/web@3.5.0
  - @nifrajs/agent-review@3.5.0
  - @nifrajs/schema@3.5.0
  - @nifrajs/testing@3.5.0
  - @nifrajs/client@3.5.0
  - @nifrajs/mcp@3.5.0
  - @nifrajs/runner@3.5.0
  - create-nifra@3.5.0

## 3.4.0

### Patch Changes

- 8d23613: Add the opt-in `@nifrajs/webmcp` package: typed WebMCP registration, core-backed receipts, deterministic predictive-UI reconciliation, and host-independent conformance checks. Also tighten agent execution cancellation cleanup so aborted local work cannot leak into later turns.
- 8d23613: Add an opt-in Vite aggregate-CSS and deferred stylesheet-loading path that prevents lazy-route prefetch from attaching additional stylesheets before hydration.
- Harden MCP error responses and browser-origin defaults, confine scaffold writes to `routes/`, and
  make sanitized HTML require an explicit sanitizer function.
- Updated dependencies [8d23613]
- Updated dependencies [8d23613]
- Updated dependencies
- Updated dependencies [719d82e]
  - @nifrajs/mcp@3.4.0
  - @nifrajs/web@3.4.0
  - @nifrajs/core@3.4.0
  - @nifrajs/schema@3.4.0
  - @nifrajs/testing@3.4.0
  - @nifrajs/client@3.4.0
  - @nifrajs/runner@3.4.0
  - create-nifra@3.4.0

## 3.3.0

### Patch Changes

- @nifrajs/client@3.3.0
- @nifrajs/core@3.3.0
- @nifrajs/mcp@3.3.0
- @nifrajs/runner@3.3.0
- @nifrajs/schema@3.3.0
- @nifrajs/testing@3.3.0
- @nifrajs/web@3.3.0
- create-nifra@3.3.0

## 3.2.0

### Minor Changes

- 652201a: Make islands the first-class interactivity lane for zero-runtime vanilla pages. `@nifrajs/web/islands`
  now exports `defineIsland` to type an enhancer's props and `createIslandBus` for typed pub/sub between
  islands that share no state. `nifra check` gains `NF-C020`, warning when an island enhancer wires an
  event listener but returns no cleanup, and `nifra scaffold` emits a golden vanilla route stub. New
  "Islands" cookbook documents the counter, cart-badge, and filter patterns.
- 19a9f84: Add `nifra_frontend` (MCP) and `nifra frontend` (CLI): a symptom-indexed catalog of client-side
  footguns across every adapter (React, Preact, Solid, Vue, Svelte, vanilla). Each entry returns the
  cause, the concrete fix, and how to verify it. It splits along the seam `nifra_check` already owns: the
  adapter-independent boundary issues (a server-only import leaking into a client component, a hydration
  mismatch, a duplicated framework runtime, loader-data typing) point at the `nifra_*` tool that fixes
  and checks them, while the per-framework reactivity-loss idioms (Vue ref, Solid props, Svelte runes,
  React effect deps) point at that framework's own ESLint plugin rather than re-implementing it. Reach
  for it when a rendered page misbehaves and the static check is green. The tool is project-independent,
  so it is served on every transport (project stdio, `nifra docs-mcp`, and the site's `/mcp` worker), and
  the per-framework `nifra_scaffold` notes now route to it.
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

- e7d55cc: Centralize repository verification gates behind stable, ID-addressed plans and expose the same plan through the project MCP server, so default and release verification cannot drift when gates change.
- e88c23a: Infer typed status responses across lifecycle hooks and contract-first routes, preserve precise
  success and error narrowing in the client, and optionally include supported response types in
  build-time OpenAPI output. Unsupported TypeScript types remain opaque and explicit runtime schemas
  remain authoritative.
- 4c81384: Harden Windows Bun dev re-exec entry detection and TypeScript route navigation across short/long path aliases.
- Updated dependencies [1a041a9]
- Updated dependencies [652201a]
- Updated dependencies [6aa39aa]
- Updated dependencies [3aefb12]
- Updated dependencies [8b58d1f]
- Updated dependencies [c4ed8f7]
- Updated dependencies [cefedc2]
- Updated dependencies [25305bb]
- Updated dependencies [095c320]
- Updated dependencies [7504864]
- Updated dependencies [e88c23a]
- Updated dependencies [c39712e]
- Updated dependencies [9010fd3]
- Updated dependencies [7551709]
- Updated dependencies [ea2356e]
- Updated dependencies [a816b87]
  - @nifrajs/mcp@3.2.0
  - @nifrajs/testing@3.2.0
  - @nifrajs/web@3.2.0
  - @nifrajs/core@3.2.0
  - @nifrajs/client@3.2.0
  - @nifrajs/schema@3.2.0
  - @nifrajs/runner@3.2.0
  - create-nifra@3.2.0

## 3.1.0

### Patch Changes

- Updated dependencies [5b78473]
- Updated dependencies [1400f6c]
- Updated dependencies [8b136ee]
- Updated dependencies [a7db515]
  - @nifrajs/core@3.1.0
  - @nifrajs/web@3.1.0
  - @nifrajs/client@3.1.0
  - @nifrajs/mcp@3.1.0
  - @nifrajs/schema@3.1.0
  - @nifrajs/testing@3.1.0
  - @nifrajs/runner@3.1.0
  - create-nifra@3.1.0

## 3.0.0

### Minor Changes

- 5a94db4: The reserved typed-client proxy keys are now a frozen, published contract with a migration path.

  `nifra fix --code NF-C018` rewrites the call sites a reserved-named route segment breaks. It reads the sites from the compiler rather than from a text search, so it finds every one and never mistakes a real `.delete` verb call for a path segment; a site it cannot rewrite confidently (bracket access, a node held in a variable) is reported and left alone rather than guessed at.

  `nifra routes` now annotates a colliding route with the reserved key and the spelling that reaches it, in both the table and `--json`, so the closed set is visible while the route is being written instead of when a build breaks. The typed-client call form printed by `nifra context` and the `nifra_routes` MCP tool is corrected for these routes too: a reserved segment is emitted as a call on the parent node, never as a property or bracket access, both of which the proxy intercepts.

  `@nifrajs/client` exports the set itself - `RESERVED_VERB_KEYS`, `RESERVED_EXACT_KEYS`, `RESERVED_KEY_READOUT`, and `reservedKeyFor(segment)` - as the one place it is written down. The list is frozen: no name is ever added to it, because adding one breaks, at compile time, every consumer that happens to have a route segment with that name. Anything the client gains from here on is reached through a namespaced or symbol key, which no URL path segment can spell.

  Client 2.12.0 should have been a major release: its reserved-segment types reject a property access that compiled in 2.11. Its changelog entry now says so, and `CONTRIBUTING.md` states the rule - a type that stops compiling is a breaking change, runtime behavior notwithstanding, and ships with a codemod.

### Patch Changes

- 5948f24: A new `check:changesets` gate fails when a package's source changed since the last release without a changeset naming it. Versioning is fixed across the workspace, so an undeclared package still bumps - it just ships with a changelog that says nothing about what moved, which is how a consumer upgrades into a change no release note mentions. The gate anchors on the last release commit in git history, so it needs no tag, base ref, or network, and it runs in `nifra check` release mode as well as CI.
- 627b0ba: `nifra` now accepts `--env-file <path>` on every command, repeatable, with later files winning and a variable already set in the process environment never overwritten.

  Commands that reflect a project (`check`, `assure`, `levels`, `routes`, `capabilities`, `manifest`, `contracts`, `openapi`, `types`) do so by importing it, and a production-grade app validates its environment at module scope. Without that environment the app aborted the process before nifra reached its first check, so the entire output was the app's own `FATAL: invalid environment` with nothing tying it to the command that was run - an app whose environment lives in an uncommitted `.env.local` simply could not be checked. A missing `--env-file` is a hard error rather than a silent no-op, so a command never looks like it verified an environment it did not load.

  When a reflected import kills the process anyway, the CLI now names the cause on the way out instead of leaving the app's bare abort as the only output.

- 293a7fe: Identity-parity findings now state the install topology, and `nifra doctor` and the build guard now answer on the same basis.

  Both tools already shared one walker, but they anchored it differently: doctor scanned the workspace that governs the project while the build guard scanned the app directory it was invoked in, so a duplicate that lives in a sibling workspace package could show up in one output and not the other. Since neither printed which directory it had scanned, that read as two tools contradicting each other about the same invariant. The scan is now always anchored on the governing workspace, both tools name the root they answered on, and a scan that stopped at the workspace-enumeration cap reports itself as partial instead of returning "no duplicates".

  A finding whose copies lie outside the directory the command was run in now says why it is still fatal there: the gate is workspace-wide deliberately, because a copy reached through a workspace-linked dependency is not visible from the app directory - the exact case that once had the check report "none" against an already-broken dev server. Running a build inside one app can therefore fail on a copy held by a sibling app, and the message states that trade rather than leaving it to look like the tool checking the wrong project.

  Each finding also carries a topology line: how many physical paths, how many install roots they fall under, and whether any of those roots sits outside the scanned root. That distinction is the whole fix decision - copies under one workspace collapse with a single reinstall from the root, while a copy under a linked checkout or a standalone sibling install belongs to another project and no reinstall here can remove it. Previously the error listed paths only, leaving that to be reverse-engineered.

  The hard gate now fails closed on a truncated scan. A scan that stopped at any of its caps - workspace packages, linked packages, or link probes - and then found no duplicates has not shown there is none; the duplicate can be sitting in the part it never reached. `assertIdentityParity` treats that state as inconclusive and throws, rather than reading an incomplete scan as a pass. The reporting surfaces (`nifra doctor`, the dev warning) still print the partial result and name the limit that was hit.

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

- 8895dca: `nifra check` picks up a TypeScript install that lands while a long-lived process is running, and refuses a "typescript" that is not the compiler.

  The rule that parses source with the project's TypeScript resolved it through a resolver that memoizes a specifier for the life of the process and, when the project has none installed, falls back to the global download cache. In a long-lived process - the MCP server - the first lookup before `bun install` pinned that cache entry, so every later check in the same session kept using it: the typecheck went phantom until the server was restarted. Resolution is now a filesystem probe for `node_modules/typescript` from the project root upward, the same walk the typecheck gate uses to find `tsc`, so an install that lands mid-session is seen on the next run.

  The cache entry it resolved to was also not a compiler, only a version stub, which crashed the scan with `undefined is not an object (evaluating 'ts.ScriptKind.TSX')` - a Nifra-looking stack trace for "no compiler is installed here". A module that does not expose the compiler API is now treated as a resolution miss, so the CLI falls back to its own copy or reports TypeScript as missing.

- 53fd454: Make `NF-C010` (workspace-linked dist older than its source) actually fixable.

  The `workspace-dist.rebuild` recipe resolved the package through the project-contained path check, but a
  workspace link points outside the project by definition - the only kind of install that can go stale - so
  the check rejected every package the diagnostic can name and `nifra fix --code NF-C010` was a silent
  no-op. Resolution now goes through the same lookup the staleness scan uses (package name -> the project's
  own `node_modules` chain -> realpath), refuses with a stated reason (registry install, no `build` script,
  not installed) instead of reporting nothing, and surfaces the package's own build failure.

  `nifra check` now names the directory and script in the warning (`cd ../pkg && bun run build`) instead of
  "usually `bun run build` in its directory", and `doctor --json` gained `packageDir` and `buildScript` on
  each stale-dist finding. `nifra fix` gained a `failed` array so one recipe that cannot act reports why
  without cancelling the rest of the run.

- Updated dependencies [f3d2a35]
- Updated dependencies [6e43c15]
- Updated dependencies [293a7fe]
- Updated dependencies [485ae60]
- Updated dependencies [627b0ba]
- Updated dependencies [f0fd370]
- Updated dependencies [004deee]
- Updated dependencies [5a94db4]
- Updated dependencies [86a555b]
- Updated dependencies [8c5f4cf]
- Updated dependencies [ee2744c]
- Updated dependencies [f0fd370]
- Updated dependencies [381bbf3]
- Updated dependencies [36801ae]
- Updated dependencies [9acadba]
- Updated dependencies [99fc683]
- Updated dependencies [73d894d]
  - @nifrajs/core@3.0.0
  - @nifrajs/web@3.0.0
  - @nifrajs/client@3.0.0
  - @nifrajs/runner@3.0.0
  - @nifrajs/mcp@3.0.0
  - @nifrajs/schema@3.0.0
  - @nifrajs/testing@3.0.0
  - create-nifra@3.0.0

## 2.14.1

### Patch Changes

- Updated dependencies [bf93902]
  - @nifrajs/core@2.14.1
  - @nifrajs/client@2.14.1
  - @nifrajs/mcp@2.14.1
  - @nifrajs/schema@2.14.1
  - @nifrajs/testing@2.14.1
  - @nifrajs/web@2.14.1
  - @nifrajs/runner@2.14.1
  - create-nifra@2.14.1

## 2.14.0

### Minor Changes

- 489c6b6: `nifra assure --json` again emits the route-assurance report `{ ok, routes, findings }`. A prior release
  had silently repurposed `--json` to print the structured `{ version, gates, verdict }` assurance bundle,
  so a consumer parsing the report shape saw its fields vanish with no version signal. The bundle is now
  opt-in behind an explicit `nifra assure --bundle` (always JSON); the bundle-only flags `--strict`,
  `--hydration`, `--interact`, and `--out` continue to imply it, and `--bundle --json` still yields the
  bundle. Plain `nifra assure` prints the human table as before. If you adopted `assure --json` for the
  bundle since it changed, switch to `assure --bundle`.
- a8130aa: `nifra build` now fails when a workspace-linked dependency ships a `dist` artifact that is missing or
  older than its source. The `"bun": "./src"` / `"default": "./dist"` conditional-export split lets Bun
  (the build, the tests) read live source while the deployed app and any Node consumer read `dist`, so a
  green build could bundle stale or absent compiled output and nothing in a diff would show it. The check
  runs after the compile proves the source is buildable and names each offending package so the fix
  (rebuild it) is obvious. It is a no-op outside a workspace, since a tarball-installed dependency cannot
  drift. The doctor already surfaces the same skew as a development-time advisory; at build time it is now
  a hard failure, because that is the artifact that ships.
- ea6b82a: `nifra --help` now lists a stable project command catalog, and the CLI, the `nifra mcp` project tools,
  and the generated `@nifrajs/cli` card all describe those commands - `check`, `assure`, `levels`,
  `capabilities`, `manifest`, `routes`, `context`, `doctor`, `fix`, `snapshot`, `diff`, `contracts`,
  `sync-manifest`, `sync-routes` - from one projection, so a command's name, one-line summary, and input
  schema can no longer drift between the three surfaces. A parity check fails the build if they do.
  `nifra verify` and `nifra prove` are intentionally excluded and stay hand-rolled.

  `nifra fix` now prints a human summary by default and reserves JSON for `nifra fix --json`; the `--json`
  shape gains an `ok` field alongside `changed` and `diagnostics`. A script that parsed plain `nifra fix`
  output as JSON must pass `--json`.

  Structured `--json` results carry a versioned envelope, and the reader still accepts the prior
  un-enveloped shape, so an existing consumer keeps working across the change.

- 489c6b6: `nifra dev` gains `--allow-duplicate-identity`, which downgrades the Vite dev server's startup
  identity-parity check from a hard failure to a loud warning. The check catches two physical copies of
  an identity-sensitive package (React, the framework adapter, `@nifrajs/core`) resolving in one process,
  which reliably breaks hydration and framework context - so it stays a hard stop by default, and
  `nifra build` never honors the flag. But when the duplicate originates in a linked sibling repo you
  cannot fix in the moment, the previous behavior took the dev server down with no way to keep working.
  With the flag, the server prints the same finding detail (packages, versions, resolved paths) and a
  reminder that duplicate identity can still corrupt hydration, then continues at exit 0. The web option
  `createViteDevServer({ allowDuplicateIdentity: true })` exposes the same escape programmatically.
- a8130aa: The interpolated-SQL rule now resolves a query-call argument identifier to its same-file initializer
  before shaping it, so extracting a variable no longer launders a finding. Previously
  `` await c.query(`SELECT ... '${input}'`) `` was flagged but the identical hoisted form
  `` const q = `SELECT ... '${input}'`; await c.query(q) `` passed clean, because const-resolution
  reached consts referenced inside a template but never the argument identifier itself.

  Resolution covers const and never-reassigned `let`, at both function-local and module scope, and
  follows a chain of identifier initializers transitively. The nearest enclosing binding wins, so a local
  never resolves through a shadowed outer name. A resolved dynamic statement is an error exactly as the
  inline form is; a static hoisted statement (including a const assembled from other static consts) stays
  green. Identifiers that cannot be resolved in-file - parameters, imports, reassigned bindings - are left
  unflagged rather than guessed at, so a helper that receives a prepared statement as a parameter is not
  falsely accused.

  New per-statement escape hatch for the case where a dynamic-looking statement is provably safe (a
  generated placeholder list, say): a `// nifra-expect sql-dynamic: <reason>` comment on or directly above
  the flagged line silences that one statement. The reason is mandatory - a bare marker with no reason
  does not suppress.

### Patch Changes

- 8dd97c0: App load now rejects a `clientModule` that has no `./` prefix but names a real local file. Such a
  specifier is read as a bare package specifier and resolved against `node_modules`, not the project - so
  `src/client.tsx` (a forgotten `./`) is ignored, no package is found, and the bundle fails deep in the
  build with an opaque "cannot resolve". Load catches it up front and reports the one-character fix
  (`./src/client.tsx`), so `nifra dev` and `nifra build` resolve the same local entry. Scoped (`@…`),
  absolute, and genuine bare-package specifiers are unaffected.
- a8130aa: `nifra doctor` now flags a running CLI whose feature version differs from the `@nifrajs/cli` (or
  `@nifrajs/core`) the project installs. A stale global or `bunx`-cached binary answering about a
  project it does not match returns types, checks, and docs that describe a surface the code does not
  have, and every answer still reads as authoritative. The finding is advisory - it names both versions
  and points at the project's own CLI, but never fails the gate on its own, since a version mismatch of
  the binary is an environment condition rather than a defect in the project. Reported only when the
  command supplies its own version, so callers that already annotate drift (the MCP server) do not
  double-report; the `--json` shape gains an optional `toolingDrift` field. Patch differences are
  ignored - they never change the described surface.
- a8130aa: `nifra check` now prints an advisory when the contract lock is vacuous - every route hashes to the
  empty-schema digest because no route declares a `body`, `query`, `params`, or `response` schema. Such a
  lock passes drift detection unconditionally: it can only ever compare an empty schema to an empty
  schema, so it guards nothing. The advisory says so and points at declaring route schemas, so a first
  run on an unschematized app does not leave a lock that looks protective but is not. A lock with no
  routes at all is not treated as vacuous, since there is no unguarded contract to warn about.
- Updated dependencies [489c6b6]
- Updated dependencies [701961a]
- Updated dependencies [62e22e2]
- Updated dependencies [62e22e2]
- Updated dependencies [62133bf]
- Updated dependencies [8dffdf4]
- Updated dependencies [489c6b6]
  - @nifrajs/web@2.14.0
  - @nifrajs/core@2.14.0
  - @nifrajs/client@2.14.0
  - @nifrajs/mcp@2.14.0
  - @nifrajs/schema@2.14.0
  - @nifrajs/testing@2.14.0
  - @nifrajs/runner@2.14.0
  - create-nifra@2.14.0

## 2.13.0

### Minor Changes

- 6510fdc: Add `nifra verify`, one command that runs the repository verification gate. `--release` runs the full
  build, test, coverage, corpus, consumer, and cross-runtime set; the default runs a fast lint,
  typecheck, and test pass. `--json` emits a machine-readable result carrying each gate's status and
  remediation, so the same gate serves humans, CI, and agents.

### Patch Changes

- Updated dependencies [e0b2dd6]
- Updated dependencies [7535ce1]
- Updated dependencies [1704308]
- Updated dependencies [6510fdc]
  - @nifrajs/core@2.13.0
  - @nifrajs/web@2.13.0
  - @nifrajs/client@2.13.0
  - @nifrajs/mcp@2.13.0
  - @nifrajs/schema@2.13.0
  - @nifrajs/testing@2.13.0
  - @nifrajs/runner@2.13.0
  - create-nifra@2.13.0

## 2.12.1

### Patch Changes

- Updated dependencies [fba30c7]
  - @nifrajs/core@2.12.1
  - @nifrajs/client@2.12.1
  - @nifrajs/mcp@2.12.1
  - @nifrajs/schema@2.12.1
  - @nifrajs/testing@2.12.1
  - @nifrajs/web@2.12.1
  - @nifrajs/runner@2.12.1
  - create-nifra@2.12.1

## 2.12.0

### Minor Changes

- df100d3: Canonical project evidence: a single reflected snapshot of a project's routes, schemas, assurance,
  and capabilities, exported as `@nifrajs/core/evidence` (`snapshotProjectEvidence`). Tools that used
  to reflect the app a second time now project from the snapshot instead, so the manifest, the check
  report, and introspection cannot disagree about what the app declares.

  `createManifest` accepts the snapshot as `evidence` and skips its own reflection when given one. It
  refuses to emit a manifest whose route-assurance or capability evidence is failing, so a manifest is
  never a record of a project that does not pass its own gates. The previous `source` input still
  works; one of the two is required.

- df100d3: `nifra check`'s text-scanning rules confirm their candidates against a parsed source model before
  reporting. A route path spelled inside an ordinary string, a `return new Response(` written in a
  comment or template text, and an erased inline `import { type X }` no longer produce findings that
  a reader has to dismiss by hand.

  The parser is a refinement, never a relaxation: it is invoked lazily - only once a lexical scan
  finds something worth disambiguating - the parse is cached across rules for the run, and a file that
  fails to parse keeps its lexical finding so the security rules stay fail-closed.

- b5aa099: `nifra check` verdicts are now install- and cwd-invariant, fully visible in the text report, and configurable per rule:

  - **Report parity.** Every diagnostic that affects the exit code now appears in the human text report, not only in `--json` - registry rules and application rule packs render under their code titles, and the trailer states the exact error/advisory counts behind the verdict.
  - **Typecheck can no longer skip silently.** A project with a `tsconfig.json` but no installed TypeScript now fails the check with an actionable diagnostic (`bun add -d typescript`) instead of a dim skip line, and the skip note names the reason.
  - **Project-resolved compiler.** `tsc` and the TypeScript API used by compiler-backed lints resolve upward from the project root (monorepo hoisting included), so verdicts no longer depend on the working directory or on how the CLI was installed. Security lints that cannot run without TypeScript emit an explicit "did NOT run" advisory instead of passing silently.
  - **`nifra.check.json` rule overrides.** A new `rules` map accepts per-rule `severity` (`error`/`warn`/`info`/`off`) and `ignore` globs, keyed by NF- code or legacy rule name; applied overrides are echoed in the report and the JSON result for auditability, and invalid entries warn instead of silently applying.
  - **NF-S002 severity by file role.** Non-constant-time secret comparisons in server-role files (`*.server.ts`, `server/`, `backend.ts`) stay errors; the same pattern in client-leaning files (`.tsx`/`.jsx`, `routes/`) reports as a warning. The `@nifra-gate-reviewed` marker now applies from anywhere inside the preceding comment block.

- 27e06a9: Typed collision escape for reserved-named route segments. The client proxy resolves the seven HTTP verbs (any casing) plus `subscribe`, `ws`, `index`, and `then` before path segments, so a route like `POST /api/delete` cannot be reached by dot access - `api.delete` is the DELETE verb. The typed spelling is now a call on the parent node: `api.api("delete").post()` sends `POST /api/delete`. The call signature accepts exactly the colliding segment names under that node (it is not a general string path builder), coexists with param calls on the same node (an object is a param bag, a string literal the segment), and covers all eleven reserved names including `then`. Purely additive - no runtime change, no existing call site affected.

  `NF-C018` accordingly downgrades from error to warning and its message now spells out the escape call for the flagged route, alongside the existing rename and `nifra-expect reserved-segment` options.

- 9314567: `nifra doctor` follows linked dependencies when looking for duplicate installs. A package linked in
  from a sibling repo (`link:`, `npm link`, a local file dependency) resolves through a symlink that
  leaves the workspace, and the copies of `@nifrajs/*` installed inside that sibling were invisible to
  the duplicate check - the exact shape that produces two incompatible copies of core in one build.
  Doctor now resolves each linked dependency to its real path, probes it for identity-sensitive
  packages, and reports every copy with the path it was found at. The scan is bounded (linked roots
  and probes are capped) and stays inside the linked package's own repository.
- 3d8d8e4: Add production-readiness checks to `nifra doctor`, including target-aware reporting and a `--strict` mode for failing when applicable guarantees are absent.
- ce3128f: `nifra mcp` resolves the project it describes instead of trusting the directory it was spawned in.
  An MCP client configured with a different working directory used to get confident answers about
  whatever happened to be there - or about no project at all - with nothing in the response saying so.

  - `nifra mcp <dir>` takes an explicit project directory; a human-named root always wins.
  - Without one, the spawn directory walks UP to the nearest nifra marker (a `package.json` depending
    on `@nifrajs/*`, or a `nifra.config.ts` monorepo root), so starting in a subdirectory still lands
    on the project.
  - After the handshake the server reads the client's MCP `roots`. When the guess found no project, or
    found one disjoint from every workspace root, and exactly ONE workspace root is a nifra project,
    that root is adopted. Ambiguity adopts nothing.
  - What cannot be resolved fails closed: project-scoped tools refuse with a remediation message that
    lists the candidate roots. When a root IS in effect, every project tool result carries a note
    naming it, and the `initialize` instructions announce it.

- ba85ce7: The MCP server says when it is answering from a different nifra than the project builds with. A
  client that launches a globally installed `nifra mcp` gets confident, authoritative answers about
  types, checks, and docs from whichever CLI version happens to be on the machine - the mismatch is
  invisible in every answer. The server now compares its own version against the `@nifrajs/cli` (or
  `@nifrajs/core`) installed in the resolved project root, and when the feature versions differ it
  stamps a warning naming both versions on the `initialize` instructions and on every project tool
  result, with the command that runs the project's own CLI instead. Patch-level differences are not
  reported.
- 5a02c51: Route-table lints in `nifra check`: `NF-C018` (error) flags routes whose static path segments spell a reserved typed-client proxy key (get/post/put/patch/delete/head/options in any casing, plus `subscribe`, `ws`, `index`, `then`) - such routes are unreachable through the typed client; opt out for an intentionally non-typed-client route with `// nifra-expect reserved-segment` above the registration. `NF-C019` (error) flags the same method+path registered twice in one file, where which registration serves is undefined.
- 0aadd62: Four new built-in security lints in `nifra check`: `NF-S004` warns when a `cors` origin predicate never reads the origin (it allows every origin), `NF-S005` warns on `redirect(..., { external: true })` call sites so open-redirect surfaces stay auditable, `NF-S006` warns when a security escape hatch (`allowLengthless`, `allowGlobalKey`, `allowInProduction`) is enabled and names the assurance claim it weakens, and `NF-S007` (info) nudges Secure cookies toward `__Host-`/`__Secure-` prefixes. All four honor the `@nifra-gate-reviewed` marker and share the existing one-parse-per-file pipeline.
- 866d59f: `nifra check`'s interpolated-SQL rule follows a query fragment into the module that exports it. A project that keeps its column lists and order clauses in a `sql-fragments.ts` and imports them by name no longer gets an error on every query assembled from them, so the rule's errors stay the ones worth reading.

  Resolution stops wherever proof does, because a wrong resolution here silences a real SQL injection rather than reporting a false one. It follows `export const NAME = "…"`, the two-statement `const NAME = …; export { NAME }`, and barrels (`export { NAME } from`, `export *`), reached by a named import from a relative specifier that lands on real source inside the project. Everything else still flags: a default or namespace import, an exported `let`, an initializer that is a call, a bare specifier (a dependency's exports are not the project's to prove), two `export *` sources offering the same name, a chain longer than three modules, a cyclic barrel, a file that does not parse, and a local binding that shadows the import. A resolved fragment still feeds the keyword scan, so hostile SQL parked in a shared constant is found rather than trusted, and the fragment's own identifiers are read in its own module - never in the file that imported it.

- a5d3f5b: Add stable diagnostic codes, application-supplied rule packs, fix recipes, assurance bundles, contract lock snapshots, hydration assurance hooks, replay metadata, security verification rules, and idempotency proofs.
- e2d1939: Add typed tool contracts with shared fail-closed adapters, static verification work graphs, bounded provider-neutral agent turns, deterministic trajectory replay, and an explicit execution-policy seam with a non-isolating local process adapter.
- e83e6eb: A capability provenance rule that matches nothing is now a finding. Seam specifiers in
  `provenance.imports` and `provenance.routeModules` are compared with the text the code imports, so a
  rule written as `src/db` when the module is imported as `./src/db.ts` silently governed zero
  modules - the policy looked satisfied because nothing was ever attributed to it. `nifra check` now
  reports `unmatched-provenance-seam` for every declared seam no scanned source matched, with the
  nearest specifiers that were actually seen ("did you mean ...?") and a fix that points at rewriting
  the rule to match the import, or deleting it.

  `forbiddenImports` is deliberately excluded: zero matches there is the success state.

  A rule that is genuinely absent in some projects sharing one policy can opt out with
  `optional: true`, which suppresses the finding for that seam only.

### Patch Changes

- 33548fe: The two CLI paths that bound a caller-supplied path to the project root now resolve it through the
  filesystem instead of comparing strings. `loadBackend`'s entry check and `resolveProjectDir` both
  compared the textual path, so a symlink inside the project pointed anywhere and still read as inside -
  and importing an entry executes it. Both now canonicalize with `realpath` before the containment test
  (`resolveProjectDir` walks up to the deepest existing ancestor, so a not-yet-created directory still
  resolves), and the test itself covers the Windows cross-drive case where `relative()` returns an
  absolute path that starts with neither `..` nor a separator.

  `nifra init-agents` refuses to write through a symlink: a symlinked ancestor directory or a symlinked
  target file aborts with an error rather than landing the file wherever the link points. Writes are
  also atomic (temp file plus rename, `wx` so the temp cannot follow an existing name), so an
  interrupted run can no longer leave a half-written config behind.

- 0a91064: The docs, examples, and types MCP searches bound their own cost. A query is truncated to 256
  characters and 12 distinct terms before scoring (`MAX_QUERY_CHARS` / `MAX_QUERY_TERMS`), and the
  schemas advertise the same 256-character limit. Each bundled corpus is read once per process and its
  sections are parsed, tokenized, and lowercased once, instead of on every call - the corpus ships
  immutable in a published build, so there is nothing to invalidate.

  Auto-fixes write only inside the project. A diagnostic path is rejected when it is absolute, when it
  escapes the root lexically, or when its real path lands outside after symlinks resolve; the fix is
  skipped rather than applied. Both the generic MCP edit path and the fix recipes share the one
  `resolveInsideProject` helper.

- Updated dependencies [df100d3]
- Updated dependencies [0efacea]
- Updated dependencies [cd1732c]
- Updated dependencies [df100d3]
- Updated dependencies [27e06a9]
- Updated dependencies [9a9346e]
- Updated dependencies [b5f47c0]
- Updated dependencies [fc33c0f]
- Updated dependencies [7dd3f28]
- Updated dependencies [fa51aba]
- Updated dependencies [c4e8bb0]
- Updated dependencies [11d1658]
- Updated dependencies [33ee9ff]
- Updated dependencies [9a692a2]
- Updated dependencies [5f71c23]
- Updated dependencies [3788b36]
- Updated dependencies [0863ef0]
- Updated dependencies [ae5338f]
- Updated dependencies [8847825]
- Updated dependencies [cb04de8]
- Updated dependencies [f3cc02e]
- Updated dependencies [9a9346e]
- Updated dependencies [4c2123d]
- Updated dependencies [5e4e31a]
- Updated dependencies [24f1787]
- Updated dependencies [9a9346e]
- Updated dependencies [b045f9e]
- Updated dependencies [df07059]
- Updated dependencies [9a9346e]
- Updated dependencies [9a9346e]
- Updated dependencies [dbc0b79]
- Updated dependencies [bd5c624]
- Updated dependencies [3868e1b]
- Updated dependencies [a5d3f5b]
- Updated dependencies [00819c5]
- Updated dependencies [e2bdd4a]
- Updated dependencies [e2d1939]
- Updated dependencies [e83e6eb]
- Updated dependencies [64d25db]
- Updated dependencies [c55f7a3]
- Updated dependencies [f8b0097]
  - @nifrajs/core@2.12.0
  - @nifrajs/client@2.12.0
  - create-nifra@2.12.0
  - @nifrajs/web@2.12.0
  - @nifrajs/mcp@2.12.0
  - @nifrajs/schema@2.12.0
  - @nifrajs/testing@2.12.0
  - @nifrajs/runner@2.12.0

## 2.11.0

### Minor Changes

- b80a1af: Every run says which bundler it is on. `nifra dev` and `nifra build` print a `bundler:` line under their banner - the pipeline, and how it was arrived at: the Bun default with the flag that switches away from it, a `--vite` / `--bun` the user asked for, or an automatic Vite selection with the config reason that forced it. An auto-selected Vite build no longer looks like the default.

  `nifra check` and `nifra doctor` answer the same question without starting a server, and the `nifra_check`, `nifra_doctor` and `nifra_context` MCP tools return it in their results. They read the config as text, so the answer is available on a repo before its dependencies are installed.

  They also report the hazards that exist only because there are two pipelines:

  - a plugin in the slot the other bundler reads - accepted, never called, and the build still succeeds
  - a dev toolchain imported by the file `nifra build` bundles into the production server entry, which builds cleanly and then fails at startup on a bundler dependency
  - `conditions` under `nifra dev` on Bun, whose client bundler takes no resolve conditions

  Slot mistakes and a toolchain in the server entry fail the check; the resolve-condition notice is advisory.

  The dev-and-HMR guide gains a "Which pipeline runs, when" table covering every config and flag combination, and the terminal output that answers it for a given app.

### Patch Changes

- c29e0d0: Svelte runs on the Vite pipeline. `nifra dev` and `nifra build` now serve and build a Svelte app on either bundler, so a Svelte app is no longer the one framework pinned to a single pipeline, and pages render with routing context, typed search and layout data intact on both.

  `@nifrajs/web` adds `setSsrModuleLoader` / `ssrModuleLoader`, the seam that makes it work. A dev server that owns SSR resolution publishes its module loader; a render adapter that has to load a compiled asset on the server reads it and loads through it, so that asset is compiled by the same toolchain as the app's routes and renders through the same copy of the framework runtime. Adapters that ship no compiled assets are unaffected.

  `conditions` on the Bun dev pipeline reaches SSR, and says so when it cannot reach the client bundle Bun's dev server serves - a one-line startup notice instead of a package that quietly resolves to one file in dev and another in `nifra build`.

  CSS Modules class names are now identical on both pipelines. The same class hashes to the same scoped name under `nifra dev`, `nifra dev --bun` and `nifra build`, so a selector written against a generated name behaves the same everywhere.

  The dev-and-HMR guide gains a Gotchas section covering the config/adapter file split, plugin slots, resolve conditions, non-route SSR freshness, and the adapter loader.

- Updated dependencies [ed5e91c]
- Updated dependencies [30f5ea3]
- Updated dependencies [c29e0d0]
  - @nifrajs/web@2.11.0
  - @nifrajs/client@2.11.0
  - @nifrajs/core@2.11.0
  - @nifrajs/mcp@2.11.0
  - @nifrajs/runner@2.11.0
  - @nifrajs/schema@2.11.0
  - @nifrajs/testing@2.11.0
  - create-nifra@2.11.0

## 2.10.0

### Patch Changes

- 15bffdd: Add request-bound data capability evidence, resumable bounded channel subscriptions, ISR tag
  invalidation for memory and KV stores, and dependency-free Open Graph image responses with an
  optional rasterizer seam.
- Updated dependencies [5263c4e]
- Updated dependencies [15bffdd]
- Updated dependencies [15bffdd]
- Updated dependencies [15bffdd]
  - @nifrajs/web@2.10.0
  - @nifrajs/core@2.10.0
  - @nifrajs/client@2.10.0
  - @nifrajs/schema@2.10.0
  - @nifrajs/testing@2.10.0
  - @nifrajs/mcp@2.10.0
  - @nifrajs/runner@2.10.0
  - create-nifra@2.10.0

## 2.9.1

### Patch Changes

- Updated dependencies [01e36fb]
  - @nifrajs/core@2.9.1
  - @nifrajs/client@2.9.1
  - @nifrajs/schema@2.9.1
  - @nifrajs/testing@2.9.1
  - @nifrajs/web@2.9.1
  - @nifrajs/mcp@2.9.1
  - @nifrajs/runner@2.9.1
  - create-nifra@2.9.1

## 2.9.0

### Patch Changes

- Updated dependencies [b006d07]
- Updated dependencies [e05e56d]
  - @nifrajs/client@2.9.0
  - @nifrajs/schema@2.9.0
  - @nifrajs/core@2.9.0
  - @nifrajs/web@2.9.0
  - @nifrajs/testing@2.9.0
  - @nifrajs/mcp@2.9.0
  - @nifrajs/runner@2.9.0
  - create-nifra@2.9.0

## 2.8.2

### Patch Changes

- f7d68e8: Numeric limit options (body/payload byte caps, TTLs, cache sizes, concurrency, ISR revalidate windows) are now validated at construction and throw a `RangeError` on non-finite or out-of-range values instead of silently disabling the bound - a `NaN` cap previously made `size > max` comparisons fail open. JWT `requiredClaims` now checks own properties only, so inherited names like `toString` no longer satisfy a required claim. `@nifrajs/mcp-db` gates multi-statement input with a real tokenizer, bounds `run_query` materialization to `maxRows + 1` via a wrapping subquery, and skips SQLite planner pseudo-nodes when verifying the table allowlist. `nifra scaffold` refuses to write through symlinked route directories.
- Updated dependencies [f7d68e8]
  - @nifrajs/core@2.8.2
  - @nifrajs/mcp@2.8.2
  - @nifrajs/web@2.8.2
  - @nifrajs/client@2.8.2
  - @nifrajs/schema@2.8.2
  - @nifrajs/testing@2.8.2
  - @nifrajs/runner@2.8.2
  - create-nifra@2.8.2

## 2.8.1

### Patch Changes

- 93fdc89: `nifra doctor` now scans `*.test.ts`/`*.spec.ts` files for undeclared imports. Tests are part of the typechecked surface, so a package imported only by a test and declared nowhere still breaks a clean `bun install` build - doctor previously shared `nifra check`'s test exclusion and missed it. `nifra check`'s own scans still skip tests, which legitimately drive `fetch` and call routes directly.
- Updated dependencies [78d66a4]
- Updated dependencies [93fdc89]
  - @nifrajs/core@2.8.1
  - @nifrajs/client@2.8.1
  - @nifrajs/schema@2.8.1
  - @nifrajs/testing@2.8.1
  - @nifrajs/web@2.8.1
  - @nifrajs/mcp@2.8.1
  - @nifrajs/runner@2.8.1
  - create-nifra@2.8.1

## 2.8.0

### Minor Changes

- 118e4a5: `nifra dev --bun` now supports server functions and `*.server` modules. Bun's dev-server bundler accepts plugins only through bunfig's `[serve.static]` channel, so the CLI generates a config under `.nifra/dev-bun/` carrying the same production boundary plugins (server-fn RPC stubs, server-only emptying), merges the app's own bunfig `[serve.static] plugins` and `preload` entries, and re-launches itself once with `--config=` pointing at it - identical stubs across dev and build, and the old fail-closed refusal for those modules is gone. The relaunch is verified with a per-launch random token (matched against a file the parent just wrote, consumed on first read, constant-time compare), so no fixed environment value can make the server skip the boundary configuration; an unverifiable launch regenerates and re-launches instead of serving. The app's entire bunfig is carried into the generated config verbatim - jsx, defines, loaders, install settings - with path-bearing entries re-rooted; a bunfig field the generator cannot round-trip, or malformed TOML, fails loudly instead of being dropped. CSS Modules remain gated under `--bun`.

  Also fixed in `@nifrajs/web`: `serverFn<Input, Output>(...)` with explicit type arguments is now recognized by the client-boundary scanner - it previously produced an exportless stub that failed the client build with a missing-export link error (a type argument containing parentheses still fails loudly with guidance, never silently). The dev loop's background leak guard now reports the underlying bundler errors instead of a bare "Bundle failed".

- 9a6b0c3: The docs MCP's example-browsing widget tool is now `nifra_gallery` (was `nifra_examples_app`), keeping every tool on the single-word `nifra_<noun>` pattern. Its description and `nifra_example`'s now state the split explicitly: `nifra_example` returns one verified snippet as text, `nifra_gallery` opens the browsable widget. The exported `examplesAppTool` API is unchanged.
- ca60337: `nifra check`'s interpolated-SQL rule now resolves same-file constants. A module-scope `const` interpolated into a query - the shared column-projection idiom (`const COLS = "id, name"` ... `` `SELECT ${COLS} FROM ...` ``), a `const LIMIT = 50`, a const built from other consts, or a ternary whose branches are both literal - is compile-time text and no longer flags, with zero suppression config. Resolution is pure syntax with a depth cap: imported names, `let`, parameters, call results, member accesses, and shadowed names (including a hoisted `var` anywhere in the enclosing function) stay flagged exactly as before, and a resolved const still feeds the SQL-keyword scan, so hostile statement text in a const alongside a dynamic span is still caught. The named escape hatches (`unsafe`, `$queryRawUnsafe`) keep flagging statement-from-variable regardless.

### Patch Changes

- Updated dependencies [118e4a5]
  - @nifrajs/web@2.8.0
  - @nifrajs/client@2.8.0
  - @nifrajs/core@2.8.0
  - @nifrajs/mcp@2.8.0
  - @nifrajs/runner@2.8.0
  - @nifrajs/schema@2.8.0
  - @nifrajs/testing@2.8.0
  - create-nifra@2.8.0

## 2.7.1

### Patch Changes

- Updated dependencies [52c89e0]
  - @nifrajs/core@2.7.1
  - @nifrajs/client@2.7.1
  - @nifrajs/schema@2.7.1
  - @nifrajs/testing@2.7.1
  - @nifrajs/web@2.7.1
  - @nifrajs/mcp@2.7.1
  - @nifrajs/runner@2.7.1
  - create-nifra@2.7.1

## 2.7.0

### Patch Changes

- Updated dependencies [7fd0fc7]
  - create-nifra@2.7.0
  - @nifrajs/client@2.7.0
  - @nifrajs/core@2.7.0
  - @nifrajs/mcp@2.7.0
  - @nifrajs/runner@2.7.0
  - @nifrajs/schema@2.7.0
  - @nifrajs/testing@2.7.0
  - @nifrajs/web@2.7.0

## 2.6.1

### Patch Changes

- Updated dependencies [5840c98]
- Updated dependencies [80419f5]
  - @nifrajs/core@2.6.1
  - @nifrajs/web@2.6.1
  - @nifrajs/client@2.6.1
  - @nifrajs/schema@2.6.1
  - @nifrajs/testing@2.6.1
  - @nifrajs/mcp@2.6.1
  - @nifrajs/runner@2.6.1
  - create-nifra@2.6.1

## 2.6.0

### Patch Changes

- e6349e5: Security hardening across input parsing and code generation. Every regex that runs on caller-influenced input (URL paths, route patterns, stylesheet and SVG sources, manifest text) is now linear - no polynomial backtracking on adversarial input. SVG preamble stripping and tag removal can no longer splice removed delimiters into new markers. Static file serving rejects `..` traversal in the request form outright and confines the resolved path with a `relative()` containment check. Generated code embeds strings through an escaper that neutralizes `</script>` breakout and the U+2028/U+2029 line separators, and HTML entity decoding resolves `&amp;` last so double-encoded entities cannot double-unescape.
- 10fb70c: `defineMcpTool` accepts `annotations` (the MCP tool safety hints - `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, `title`), surfaced in `tools/list` and `tools/describe`. Hosts use these to pick confirmation UX, and connector directory reviews expect every tool to declare them. The hosted docs tools (`nifra_docs`, `nifra_example`, `nifra_types`, `nifra_learn`, `nifra_examples_app`) now all declare themselves read-only and closed-world.
- Updated dependencies [e6349e5]
- Updated dependencies [08fe221]
- Updated dependencies [8383063]
- Updated dependencies [10fb70c]
  - @nifrajs/web@2.6.0
  - @nifrajs/core@2.6.0
  - @nifrajs/mcp@2.6.0
  - @nifrajs/client@2.6.0
  - @nifrajs/schema@2.6.0
  - @nifrajs/testing@2.6.0
  - @nifrajs/runner@2.6.0
  - create-nifra@2.6.0

## 2.5.0

### Minor Changes

- 8251dfd: `nifra doctor` and `nifra check` now flag stale workspace dists. A workspace-linked dependency whose export map splits `bun` (source) from `default` (a `dist` artifact) serves live source to Bun but a build artifact to Vite's SSR runner and node consumers - and nothing in the dev loop rebuilds that artifact. Because `dist/` is gitignored, the drift never shows in a diff; it surfaces as a 500 inside the package's code and reads like an upstream regression. The new `stale-workspace-dist` rule compares each linked dependency's `default` target mtime against its newest source file and reports "rebuild <pkg>" with the lag (or "never built" when the artifact is missing). Advisory severity: it warns in the report and the `--json`/MCP diagnostics but never fails the gate, since a linked package's dist is legitimately behind while you are mid-edit. npm tarball installs are immutable and never flagged.

### Patch Changes

- Updated dependencies [3731c69]
- Updated dependencies [31ccc27]
- Updated dependencies [02d9aa8]
- Updated dependencies [0740f77]
  - @nifrajs/mcp@2.5.0
  - @nifrajs/testing@2.5.0
  - @nifrajs/web@2.5.0
  - @nifrajs/client@2.5.0
  - @nifrajs/core@2.5.0
  - @nifrajs/runner@2.5.0
  - @nifrajs/schema@2.5.0
  - create-nifra@2.5.0

## 2.4.0

### Minor Changes

- 1c2bf5a: The self-hosted docs MCP (`nifra docs-mcp` / `handleMcpHttp`) now serves `nifra_examples_app`, an MCP Apps widget that renders the verified code examples as an interactive, filterable list in hosts that support it; text-only hosts still get the example names. It reads the same bundled examples corpus as `nifra_example`, so every self-host exposes it from one definition.
- 335eb2a: A guided, ordered path to build a nifra app end to end.

  `nifra_learn` (MCP) and `nifra learn` (CLI) walk the same sequence - create the app, add a page route, load data, add a typed API, call it through the typed client, protect a route, do background work, deploy. Each step names the tool that emits the correct artifact (`nifra_scaffold`, `nifra_example`, `nifra_run`) and how to verify it, so the path composes the existing tools instead of pasting code that can drift from the installed version. Random-access search stays `nifra_docs`/`nifra_example`; this is the sequence for building something new.

- 795357f: DevTools' request-trace buffer is now queryable, not just streamable.

  Alongside the live SSE overlay, the plugin serves a one-shot JSON snapshot at `/_nifra/devtools/state` - the recent request traces (method, path, status, duration, ISR status, response bytes), filterable by a `path` prefix and a `limit`, and guarded exactly like the stream (loopback-only unless `allowRemote`, origin-checked, optional `authorize` hook). A new `filterDevToolsEvents` export defines that query once, shared by the endpoint and its consumers.

  `nifra_inspect` (MCP) reads that snapshot for a running dev server, so an agent can SEE what its requests actually did - which route answered, the status, how long, ISR hit or miss - instead of inferring it from the response alone. It needs the app to mount the `devtools()` plugin (which auto-enables in development).

- 23e6eb1: Errors resolve to a structured diagnostic - one object a person reads in the overlay and an agent reads as JSON.

  The dev error overlay now shows a source codeframe around the offending line and, for failures nifra recognises (a server-only module or a `node:` built-in reaching the client, a schema mismatch), a plain-language cause and fix with a docs anchor. A new `@nifrajs/web/diagnostic` export builds that `Diagnostic` - stable `code`, the top frame in your own source, the codeframe, and the cause/fix - from any thrown value, and the dev server serves the most recent one as JSON at `/__nifra/last-error`.

  `nifra_explain` (MCP) turns an error - pasted from `nifra_run`/`nifra_test` output, or the dev server's last - into that same diagnostic, so an agent gets the code, the codeframe in your source, and the fix instead of eyeballing a stack trace.

- 06f4aaa: `nifra upgrade` refuses to roll a dependency backward, and duplicate-install diagnostics name the type-inference symptom.

  `nifra upgrade <version>` now fails closed when a target would set any pin below the installed version (for example running an older recipe on a newer install), listing each pin that would roll back and writing nothing; pass `--allow-downgrade` to apply it intentionally. `nifra doctor` and `nifra check` additionally call out that a second `@nifrajs/core` copy is the usual cause of `typeof backend` collapsing to `any` at `.merge()`.

### Patch Changes

- 1c2bf5a: Harden the dev-only diagnostics endpoint and the agent-facing reads of it. The dev server now binds to `127.0.0.1`, answers `/__nifra/last-error` with an identity header, and resolves source paths so the codeframe stays inside the project. The Vite dev server serves that endpoint at parity with the Bun one. `nifra_explain` and `nifra_inspect` validate the target port, time out, cap the response size, and only return a body from a verified nifra endpoint - so pointing them at an unrelated local service returns a clear error instead of that service's response.
- 1c2bf5a: `nifra upgrade`'s downgrade guard now respects prerelease precedence, so a target of `2.3.0-beta` is correctly treated as older than an installed `2.3.0` and blocked without `--allow-downgrade`. Previously only the numeric core was compared, so a release-to-prerelease step slipped past the guard.
- Updated dependencies [06f4aaa]
- Updated dependencies [1c2bf5a]
- Updated dependencies [138bfba]
- Updated dependencies [23e6eb1]
- Updated dependencies [06f4aaa]
  - create-nifra@2.4.0
  - @nifrajs/web@2.4.0
  - @nifrajs/core@2.4.0
  - @nifrajs/testing@2.4.0
  - @nifrajs/client@2.4.0
  - @nifrajs/schema@2.4.0
  - @nifrajs/mcp@2.4.0
  - @nifrajs/runner@2.4.0

## 2.3.0

### Minor Changes

- 77715ca: `nifra check` fails on SQL built by interpolating a value into the statement text.

  ```ts
  db.query(`SELECT * FROM notes WHERE id = ${id}`); // fails the check
  db.query("SELECT * FROM notes WHERE id = ?").get(id); // bound
  db.execute(sql`SELECT * FROM notes WHERE id = ${id}`); // bound by the tag
  ```

  The interpolated value becomes statement rather than parameter, so anything the caller controls can end
  the literal and continue as SQL.

  Two things it deliberately stays quiet about, because flagging a safe idiom is how a rule gets ignored:
  a TAGGED template (`` sql`… ${id} …` `` in postgres.js, drizzle and kysely binds its substitutions -
  that IS the parameterised form), and any literal without a substitution. A SQL keyword is required in
  the literal too, so `cache.query(`user:${id}`)` is left alone; the named escape hatches
  (`$queryRawUnsafe`, `sql.unsafe`) are flagged on the call alone, since taking a statement as text is
  their entire purpose.

- ea0a27f: Capability provenance says when it could not finish, instead of reporting a clean project.

  The reachability walk stops at a module count and an import depth so a pathological graph cannot hang
  the check. Hitting either limit used to end the walk quietly, and the route came back covered - a
  passing report whose subject was partly unexamined, which is the shape of failure this whole gate
  exists to prevent.

  Both limits now produce a `provenance-truncated` finding naming the route and the chain that reached
  it, the check fails, and the lockfile refuses to record a snapshot taken from a truncated walk.

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

- ea0a27f: The interpolated-SQL rule reads the syntax tree, and TypeScript is an optional peer rather than a
  dependency.

  The rule used to work on text, which meant guessing where strings and comments began and ending up
  lenient in the direction that matters: EVERY tagged template was treated as parameter binding, so
  `String.raw` or any no-op custom tag hid an interpolated statement from the check. It now parses with
  the compiler and trusts only `sql` and `Prisma.sql`. It also reads a concatenated statement built
  across `+`, and skips a file the parser could not read rather than turning recovery nodes into a second
  misleading diagnostic.

  Trust is by NAME, and that is the honest limit of a scanner that reads syntax and runs no type checker:
  `sql` is what postgres.js, drizzle, slonik and Bun's driver all call theirs, and nothing here can prove
  a given `sql` binds anything. A no-op function with that name is trusted too. The rule finds mistakes,
  not an adversary who has read it - deciding otherwise needs a type checker, which is a different tool.
  Names earn their place on that list by being what drivers already call the thing.

  The compiler is a ~25 MB install, and the CLI's own typecheck step already treats `tsc` as something
  the project provides. Forcing it on every install to run one rule was the wrong trade, so it is an
  optional peer resolved when the rule runs. Every Nifra project has TypeScript - the templates all ship
  a `typecheck` script - so this resolves in practice.

  When it does not, `nifra check` says the rule did not run and how to enable it. That part is not
  cosmetic: an empty result is indistinguishable from a clean one, and for this rule a clean result means
  "no SQL injection was found". Silence there is the one answer it must never give.

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

### Patch Changes

- e88f36b: Two CI gates that could report success having measured nothing.

  `@nifrajs/events` shipped with 17 passing tests CI had never executed. The two run scripts list their
  30-odd test directories by hand and nobody added the new one, so the package published untested and the
  coverage ratchet was blind to it. The dead suite was the fail-closed half of a durable event boundary.
  A completeness check now asserts every package with test files appears in both scripts, with an
  explicit, reasoned opt-out list.

  `check:size` dropped any row that failed to build - logging to stderr, returning null - and then
  compared budgets only against rows that survived. Rename a `@nifrajs/core/*` subpath and its row
  vanishes with its budget, every remaining row passes, and the gate exits 0. It now reconciles measured
  rows against declared rows, and the budget table against the feature matrix, before comparing anything.

- b9f4525: `nifra build` and `nifra dev` now print the real cause of a failed bundle. When `Bun.build` throws, it raises an `AggregateError` whose own message is a generic "Bundle failed" and whose underlying errors - the unresolved import, the plugin that threw, each with a file and line - were dropped by the CLI's error output. Those causes are now unwrapped and printed, one per line, at every CLI error boundary.
- 1fbfb62: A `clientModule` given as a relative path (a local client entry, e.g. `./src/client.tsx`) now works in both `nifra dev` and `nifra build`. It is resolved to an absolute path when the framework config loads, so the generated client entry - which dev and build write into different directories - resolves it identically in both phases instead of loading in one and breaking in the other. A bare or package specifier (`@nifrajs/web-react/client`) is location-independent and unchanged.
- c42d777: Documents seven packages that shipped without a single reference.

  `web-vanilla` (zero-framework adapter) joins the frameworks page and gains `examples/web-vanilla`;
  `devtools` joins dev; `mock` joins testing; `events` joins backends; `prompt`, `agent-telemetry` and
  `mcp-db` join the coding-agents page.

  All were real - 185 to 381 lines each, 9 to 23 tests each - and none were findable. Every added sample
  is compiled by the docs gate against the live API.

- fc034c6: Documents server functions and effect provenance.

  Two features shipped without a page. Server functions span seven packages and had none at all, and the
  effect provenance firewall - now armed in every template - emits a finding (`unconfined-write-reach`)
  whose fix is structural and was explained nowhere outside code comments.

  Both pages join the docs corpus the MCP server and `nifra_docs` search read from, so an agent finds them
  too.

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

- ea0a27f: A scaffolded project's `check` script runs the assurance gate it ships with, and the dev refusals cover
  extensionless modules.

  Every template ships an assurance config, and every template's `check` script ran `nifra check` only -
  so the policy was shipped, documented, and never executed by the command a project actually runs in CI.
  It now runs `nifra check && nifra assure`.

  `nifra dev --bun` refuses `.server` and `.fn` modules because Bun's dev bundler takes no plugins and
  would ship them whole. The refusal missed a module with no extension at all, which is the one shape a
  directory import produces.

- 1ed58b8: The documentation site now holds the bar it sells: `nifra.assurance.ts` plus a capability lockfile, at
  L2.

  It is also the first validation of the capability model on an app nobody designed around it. Two things
  that only a real app can answer:

  - **No false positives.** 47 route files carry dozens of documentation samples containing
    `import { Database } from "bun:sqlite"` and friends inside template literals. None became capability
    evidence, because the scanner blanks template contents before reading imports.
  - **Real imports are still caught.** Adding one genuine `bun:sqlite` import to the backend immediately
    flagged all four routes, including the GET dead end with its structural message.

- 803ec9d: `nifra_types` answers for every published package.

  `@nifrajs/deno`, `@nifrajs/content` and `@nifrajs/workers` contributed nothing to the type index the
  MCP tool reads. They ship `files: ["src"]` and point `types` at `./src/index.ts`, which is right for a
  package resolved by Deno, workerd or Bun, while the index only ever looked for a built `dist/*.d.ts`.
  Asked about `serve`, `defineCollection` or `createWebSocketHub`, an agent got nothing back and wrote
  the API it guessed instead.

  Their declarations are now emitted from source, per file and without a type checker, so the index
  starts where a consumer's resolver starts either way. Signatures are declarations, not implementations
  pasted in; the 1,545 entries already there are byte-identical.

  The `--check` gate could not have caught this - it compares the regenerated file against the committed
  one, and a package missing from both matches forever. So `gen:llms` now fails when a published package
  contributes no types at all, which also turns the quietest failure here into a loud one: run it without
  building first and the file used to be rewritten with almost nothing in it.

- 5177627: `nifra check`, `nifra assure` and `nifra levels` are three views of one project verification.

  All three read the same reflected project: the typed-contract scan, the route-assurance evaluation,
  and the static capability provenance. Each had grown its own orchestration over those pieces, so which
  command ran which policy was something a caller had to keep in their head, and `nifra levels` paid for
  it twice. Its L0 rung runs the whole check, and then L1 and L2 re-derived the route-assurance and
  capability-provenance evidence that same check had just produced. On a project with a capabilities
  policy the provenance walk is the expensive part, and it ran on every `levels` invocation once for the
  check and again for the ladder.

  They now derive from a single verification pass. Each command renders its own slice of it: `assure`
  still never triggers the typecheck it has no use for, and `levels` climbs the ladder from evidence
  gathered once rather than a second time per rung. The output of all three is unchanged down to the
  byte, and a golden test per command and per mode holds that line so it stays that way.

- 4eb4e15: The release's version script regenerates the llms corpora, so the "Version Packages" PR can pass CI.

  `types.json` stores exported signatures verbatim, including core's `VERSION` as the literal type
  `export declare const VERSION: "2.2.0"`. Bumping the version rewrote that constant and regenerated
  `api-reference.md` and the LLM cards, but not the corpora - so every Version PR failed `check:llms` on a
  stale `types.json`, and since Release only publishes after CI concludes successfully, nothing could
  ship.

- Updated dependencies [6f5b3ad]
- Updated dependencies [cee03d7]
- Updated dependencies [85b354d]
- Updated dependencies [9b110b9]
- Updated dependencies [7293a1c]
- Updated dependencies [c8b79d7]
- Updated dependencies [8514caa]
- Updated dependencies [ea0a27f]
- Updated dependencies [ea0a27f]
- Updated dependencies [45b0733]
- Updated dependencies [c42d777]
- Updated dependencies [ea0a27f]
- Updated dependencies [82b2053]
- Updated dependencies [b271164]
- Updated dependencies [8c77d47]
- Updated dependencies [ea0a27f]
- Updated dependencies [26cec7d]
- Updated dependencies [8807004]
- Updated dependencies [ea0a27f]
- Updated dependencies [35af9fe]
- Updated dependencies [ea0a27f]
- Updated dependencies [d190b1c]
- Updated dependencies [a4ecca9]
- Updated dependencies [de8d992]
- Updated dependencies [a92104e]
- Updated dependencies [7f55876]
- Updated dependencies [5fe332a]
- Updated dependencies [c823915]
- Updated dependencies [d2840ac]
- Updated dependencies [62a8d03]
- Updated dependencies [dcacfe7]
- Updated dependencies [28704d7]
- Updated dependencies [ea0a27f]
- Updated dependencies [0c2de22]
  - @nifrajs/core@2.3.0
  - create-nifra@2.3.0
  - @nifrajs/client@2.3.0
  - @nifrajs/web@2.3.0
  - @nifrajs/schema@2.3.0
  - @nifrajs/testing@2.3.0
  - @nifrajs/mcp@2.3.0
  - @nifrajs/runner@2.3.0

## 2.2.0

### Minor Changes

- 2441577: `nifra build` picks its bundler from your config instead of a fixed default, and `--bun` joins `--vite`.

  The two phases default differently on purpose: `nifra dev` is Vite (for the plugin ecosystem, and because
  Bun's dev-server bundler cannot compile CSS Modules), `nifra build` is Bun (faster, Bun-native). For an app
  with no transforms that costs nothing - there is nothing for the two to disagree about. For an app whose
  only transforms are `vitePlugins` it cost a class of production-only bug: those plugins ran in dev, and the
  Bun build reads `clientPlugins`/`serverPlugins` and never `vitePlugins`, so it dropped them. The build
  succeeded, the output looked plausible, and the transform had simply not happened.

  That is the failure the pipeline-separation guard already refuses to allow - a plugin whose pipeline never
  runs - reached by crossing phases instead of slots, where the slot check cannot see it because the plugins
  are correctly placed.

  So the default now follows the app. Vite plugins with no Bun counterpart means exactly one pipeline can
  build it, and that is the one used; `nifra build` prints the reason so an auto-selected Vite build never
  looks like you got the default. An app declaring both slots has supplied the Bun equivalent deliberately -
  nothing is dropped - so the faster Bun default stands, unchanged. An app with no plugins is unaffected.

  `--vite` and the new `--bun` force the choice, with one exception: `--bun` on an app whose only transforms
  are `vitePlugins` is refused, naming the plugins it would discard, rather than producing the silently
  incomplete build the flag would otherwise ask for. Passing both flags is an error.

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

- 78e0b02: `nifra dev --bun` - the Bun pipeline is now selectable in dev, completing the pipeline matrix.

  `nifra build --vite` already let an app choose its production bundler, but dev was Vite-only from the
  CLI: the Bun dev server existed solely as a library entry (`@nifrajs/web/dev`), so using it meant
  hand-writing a `dev.ts`. `nifra dev --bun` runs it directly - `Bun.serve`'s native HMR bundles and
  hot-reloads the client while Bun's runtime resolves SSR, with no Vite in the process. Both pipelines are
  now selectable in both phases, and neither ever runs inside the other.

  It refuses one case rather than breaking quietly. Bun's DEV-server bundler and `Bun.build` are not the
  same bundler: `Bun.build` compiles `*.module.css` into a scoped class map (so the Bun production build of
  a CSS-Modules app is fine), but the dev server's bundler has no such transform - the import becomes a
  dangling reference and the browser throws `ReferenceError: import_X_module is not defined` from inside the
  component, naming neither CSS Modules nor the dev server. So `--bun` checks for CSS Modules up front and
  refuses with the offending files named and both ways forward. The check is deliberately narrow: only the
  transform proven missing is refused, so an app without CSS Modules gets the Bun dev loop.

  Bun applies React Fast Refresh natively on this path - verified: editing a component-only module swaps its
  markup while a `useState` counter keeps its value, with no reload. The boundary rule is the same one Vite
  has (a route file that also exports `loader`/`meta` is not a refresh boundary, so saving it reloads). Plain
  CSS and Tailwind work; only `*.module.css` is refused.

  Default is unchanged - `nifra dev` stays Vite, for its plugin ecosystem.

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

### Patch Changes

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

- Updated dependencies [39b1670]
- Updated dependencies [d428f52]
- Updated dependencies [135d0c6]
- Updated dependencies [5f460db]
- Updated dependencies [1394641]
- Updated dependencies [e713cab]
- Updated dependencies [a4645e2]
- Updated dependencies [a7d740a]
- Updated dependencies [6e996a1]
- Updated dependencies [15ad6ca]
- Updated dependencies [6aa0aac]
- Updated dependencies [1857d39]
- Updated dependencies [6ba3173]
- Updated dependencies [ca71a2e]
- Updated dependencies [0fc215b]
- Updated dependencies [2ff661f]
- Updated dependencies [a1327a4]
- Updated dependencies [2500705]
  - @nifrajs/web@2.2.0
  - create-nifra@2.2.0
  - @nifrajs/core@2.2.0
  - @nifrajs/client@2.2.0
  - @nifrajs/schema@2.2.0
  - @nifrajs/testing@2.2.0
  - @nifrajs/mcp@2.2.0
  - @nifrajs/runner@2.2.0

## 2.1.0

### Patch Changes

- Updated dependencies [bd294bb]
- Updated dependencies [d3aac63]
  - @nifrajs/core@2.1.0
  - @nifrajs/client@2.1.0
  - @nifrajs/web@2.1.0
  - @nifrajs/schema@2.1.0
  - @nifrajs/testing@2.1.0
  - @nifrajs/mcp@2.1.0
  - @nifrajs/runner@2.1.0
  - create-nifra@2.1.0

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

### Minor Changes

- 6b0dbc3: Ship the executable 2.0 migration path and consolidated upgrade documentation.

  - `nifra upgrade 2.0.0` updates the fixed Nifra package group while preserving range style, moves
    the removed `@nifrajs/budget` dependency to `@nifrajs/core`, rewrites its source imports to
    `@nifrajs/core/budget`, and prints the structural cutover notes it cannot safely infer.
  - Pin rules now treat bare package names as exact matches, so upgrading `nifra` cannot rewrite an
    unrelated dependency such as `nifra-plugin`.
  - The 1.x → 2.0 guide covers opt-in runtime plugins, lean subpath imports, backend mounts, typed
    client failures, web/protocol changes, release gates, and `nifra.check.json` external mounts for
    Better Auth-style route owners.
  - External-mount matching rejects percent-encoded parent traversal as well as literal `..`, so the
    lint exception cannot hide a fetch that URL normalization moves outside its declared prefix.

- 2324d38: `nifra check` can now reach green on an app that intentionally mounts a non-typed sub-app, and raw-Response routes have an explicit opt-out.

  - **`nifra.check.json` external-mount allowlist.** A relative `fetch()` to a mounted handler that lives outside the typed contract (e.g. an auth plugin that owns `/auth/**`) was flagged as a hand-rolled own-API call - an error you could never clear. Declare those prefixes in `nifra.check.json` (`{ "externalMounts": ["/auth"] }`, segment-anchored: `/auth` blesses `/auth` and `/auth/**` but not `/authors`) and the typed-client scan skips them. The blessed prefixes are echoed on the result and printed in the report, so a suppressed mount stays auditable instead of silently hiding real drift. A malformed `nifra.check.json` is a non-fatal warning; the allowlist is simply ignored.
  - **`// nifra-expect raw-response` pragma.** A route that deliberately returns a raw `Response` (a file or redirect) raised the `response-route` advisory with no way to mark it intentional. A pragma comment on the return line, or the line above, now silences it for that route.
  - **Streaming guidance.** The `response-route` advisory now points streaming routes at the typed SSE route (`app.sse(...)`), which keeps typed events instead of collapsing the client to `data: never`.

- 5917e68: Add the `nifra_levels` MCP tool, so an agent can read the verification ladder it was already able to
  run from the CLI. It returns `{ achieved, levels[] }` across L0 typed contract, L1 route assurance,
  L2 capability lockfile, L3 route trust manifest, and L4 contract invariants, with the reasons a level
  does not hold. A project with no assurance config still answers, stopping at L0 rather than failing.
- e97a92f: `nifra sync-manifest`, plus two toolchain guards that turn opaque failures into actionable ones.

  - **`nifra sync-manifest`.** After adding/renaming/removing a page route, the committed `server-manifest.ts` drifts and `nifra check` flags it - and clearing that used to mean a full build (server + worker + migrate bundles). `nifra sync-manifest` re-scans `routes/` and rewrites just the manifest's route table in milliseconds, preserving the baked client-asset references. It does not rebuild the client bundle, so it prints a caveat: a brand-new hydrating route component still needs a full build for its client chunk. `@nifrajs/web/build` gains the pure `resyncServerManifestSource` (+ `parseManifestStyles` / `parseManifestRouteStyles`) it is built on.
  - **`nifra dev` peer preflight.** Run under `bunx @nifrajs/cli dev` (an isolated install where the project's peers do not resolve), the Vite import failed with an opaque `ERR_MODULE_NOT_FOUND`. It now checks `vite` resolves from the project first and, if not, says to run the workspace-local `bun run dev`.
  - **`nifra start` build-target guard.** Pointed at a Cloudflare Pages output (a `_worker.js` bundle, no `server.js`), `nifra start` now names the mismatch and the fix (`nifra build --target bun`, or serve with `wrangler pages`) instead of a bare "no server.js".

### Patch Changes

- 7791470: `nifra check` now prints a one-line tip when the project has no `.mcp.json`, pointing at `nifra init-agents` (which wires `.mcp.json` + `.cursor/mcp.json` + a CLAUDE.md preamble, no-clobber). The tip is non-fatal and only in the human report - the `--json` path is unchanged - so a coding agent discovers the MCP wiring instead of learning the framework from sibling-app source.
- Updated dependencies [a7b1d60]
- Updated dependencies [a7b1d60]
- Updated dependencies [eaac3d7]
- Updated dependencies [ade0c7a]
- Updated dependencies [82676e0]
- Updated dependencies [1522d06]
- Updated dependencies [b7017b9]
- Updated dependencies [d91a45b]
- Updated dependencies [d91a45b]
- Updated dependencies [e97a92f]
- Updated dependencies [202e758]
- Updated dependencies [a7b1d60]
- Updated dependencies [e8e49d1]
- Updated dependencies [a7d34e5]
- Updated dependencies [a7b1d60]
  - @nifrajs/core@2.0.0
  - @nifrajs/client@2.0.0
  - @nifrajs/schema@2.0.0
  - @nifrajs/web@2.0.0
  - create-nifra@2.0.0
  - @nifrajs/testing@2.0.0
  - @nifrajs/mcp@2.0.0
  - @nifrajs/runner@2.0.0

## 1.13.0

### Patch Changes

- f644556: `nifra doctor` also probes the workspace root for identity-sensitive packages, so it reports the split
  where every declaring package resolves one physical copy and the root holds another. Consulting only
  the packages that declare the dependency saw a single copy and stayed quiet.
- Updated dependencies [aae8614]
- Updated dependencies [5b6127a]
  - @nifrajs/core@1.13.0
  - @nifrajs/client@1.13.0
  - @nifrajs/web@1.13.0
  - @nifrajs/schema@1.13.0
  - @nifrajs/testing@1.13.0
  - @nifrajs/mcp@1.13.0
  - @nifrajs/runner@1.13.0
  - create-nifra@1.13.0

## 1.12.0

### Minor Changes

- 63d3845: Add bounded execution-causality contracts and propagation, OpenTelemetry causal links, event-envelope lineage, and a deterministic durable failure laboratory. `nifra levels` L4 now uses the deep adversarial contract engine through its explicitly isolated executor. Also add hash-verifiable adapter certification profiles and duplicate physical Nifra/React install detection in `nifra doctor`/`nifra check`.

### Patch Changes

- Updated dependencies [63d3845]
- Updated dependencies [246f498]
  - @nifrajs/core@1.12.0
  - @nifrajs/testing@1.12.0
  - @nifrajs/client@1.12.0
  - @nifrajs/schema@1.12.0
  - @nifrajs/web@1.12.0
  - @nifrajs/mcp@1.12.0
  - @nifrajs/runner@1.12.0
  - create-nifra@1.12.0

## 1.11.0

### Minor Changes

- 2dde7e5: Add the effect ledger, sandboxed contract-generated invariant tests, and the verification ladder.

  **Effect ledger** - a per-request, append-only, ordered record of side-effect intents and outcomes.
  Routes that declare `schema.capabilities` get a bounded, token-only ledger when the server enables
  `server({ effectLedger })`; each `useCapability(c, id, { target, cost, digest })` beacon
  records an intent, `recordCapabilityOutcome` records its terminal result without double-debiting
  admission, and the sink receives the sealed ledger when the response settles - on success and
  error responses alike, so partial work is audited. Entries carry capability ids, phases, adapter
  tokens, dimensionless cost counters, an optional keyed-HMAC payload digest, and bounded error codes;
  the entry type has no payload field, and the sealed ledger names the route _pattern_ plus the declared
  capability set, never the concrete URL - redaction holds by construction. Includes an optional
  tamper-evident hash chain, a bounded in-memory sink,
  and `computeEffectDigest` (keyed HMAC-SHA-256, so low-entropy data cannot be brute-forced from a
  stored digest). The hash chain binds route identity, declarations, timestamps, and entries. Sink
  failures are logged without their potentially-sensitive message and do not turn a successful effect
  into a retryable 500; transactional audit belongs in the effect's owning transaction. Routes without
  capability declarations keep the existing fast path unchanged.

  **Contract-generated invariant tests** - `runContractInvariants(app, { executor })` fuzzes each route from its
  declared JSON Schema with a deterministic seeded generator and verifies what the contract promises:
  valid inputs never crash, 2xx responses conform to the declared response schema, schema-violating
  bodies are rejected (never accepted, never a crash), and a route-level classification never
  understates its field-level tags. Findings carry the case seed for exact reproduction; ungeneratable
  routes are reported as skipped, never silently dropped.
  Dynamic execution requires an explicit `invariants.executor` backed by a disposable app/sandbox;
  verification never invokes a live app implicitly, and any skipped route prevents L4.

  **Verification ladder** - `nifra levels` computes L0 typed contract → L1 route assurance → L2
  capability lockfile → L3 route manifest → L4 invariant-tested from the existing gates. Levels are
  cumulative and computed, never self-declared; `--min <n>` gates CI on a required floor.

- 279f80c: Add a deterministic versioned Nifra manifest that joins route schemas, assurance evidence,
  capabilities, and field-level response classification in one hash-verified artifact. Manifests can be
  signed through an operator-provided Ed25519 KMS/HSM callback; Nifra never handles private keys.

  `nifra manifest emit` refuses failing assurance and writes byte-stable output, while
  `nifra manifest diff <before> <after>` hash-verifies both artifacts and fails deployment promotion on
  breaking contract, lost assurance, expanded effects, or increased data sensitivity.

### Patch Changes

- Updated dependencies [2dde7e5]
- Updated dependencies [80ed7b8]
- Updated dependencies [279f80c]
- Updated dependencies [5638ada]
- Updated dependencies [279f80c]
  - @nifrajs/core@1.11.0
  - create-nifra@1.11.0
  - @nifrajs/client@1.11.0
  - @nifrajs/web@1.11.0
  - @nifrajs/schema@1.11.0
  - @nifrajs/mcp@1.11.0
  - @nifrajs/runner@1.11.0

## 1.10.0

### Minor Changes

- 92181be: Add hardened effect and capability assurance: reflected route declarations, fail-closed runtime
  beacons, static effect-provenance analysis, deterministic capability lockfiles, HTTP safe-method
  guards, and effect-specific request or durable idempotency requirements.

  Add `nifra capabilities snapshot` and `nifra capabilities check` so capability drift and raw
  provider bypasses can be enforced in CI without adding work to the default request path.

### Patch Changes

- Updated dependencies [92181be]
- Updated dependencies [3773f0a]
- Updated dependencies [92181be]
  - @nifrajs/core@1.10.0
  - @nifrajs/client@1.10.0
  - @nifrajs/schema@1.10.0
  - @nifrajs/web@1.10.0
  - @nifrajs/mcp@1.10.0
  - @nifrajs/runner@1.10.0
  - create-nifra@1.10.0

## 1.9.1

### Patch Changes

- 3eb27ae: Internal tidy - remove a dead local variable in the query engine and clean up example wording in doc comments. No API or behavior change.
- Updated dependencies [3eb27ae]
  - @nifrajs/web@1.9.1
  - @nifrajs/mcp@1.9.1
  - @nifrajs/client@1.9.1
  - @nifrajs/core@1.9.1
  - @nifrajs/runner@1.9.1
  - @nifrajs/schema@1.9.1
  - create-nifra@1.9.1

## 1.9.0

### Patch Changes

- Updated dependencies [03cd76f]
- Updated dependencies [0e1b4cc]
- Updated dependencies [6b67833]
- Updated dependencies [03cd76f]
  - @nifrajs/core@1.9.0
  - @nifrajs/web@1.9.0
  - @nifrajs/client@1.9.0
  - @nifrajs/schema@1.9.0
  - @nifrajs/mcp@1.9.0
  - @nifrajs/runner@1.9.0
  - create-nifra@1.9.0

## 1.8.0

### Minor Changes

- e47c4c5: Add reflection-time route assurance: middleware and plugins can publish lifecycle-accurate enforcement
  evidence, ordered policies fail closed on unclassified/missing/forbidden evidence, official hardening
  middleware emits canonical evidence, and `nifra assure` exposes a human/JSON CI gate.
- 9433ad9: Add `nifra upgrade <version>`: an executable, per-release upgrade runner. A recipe declares the
  mechanical edits a target version needs - a dependency-pin sweep (sets every matching `@nifrajs/*`
  dependency to the target version across the workspace, preserving each spec's `^`/`~`/exact style and
  skipping `workspace:`/`link:` specs) and exact import-specifier moves - and the runner applies them
  `detect → transform → verify`, reusing the existing `nifra check` gate rather than adding a new one.
  Dry-run by default (`--write` applies, `--no-verify` skips the check, `--list` shows targets); fail-closed
  on an unknown version or a missing package.json; deterministic and idempotent. Ships the 1.8.0 recipe.
  Transforms are intentionally string/specifier-level - structural (AST) codemods are deferred until a
  recipe needs one.

### Patch Changes

- Updated dependencies [e47c4c5]
- Updated dependencies [1ffd48b]
  - @nifrajs/core@1.8.0
  - @nifrajs/web@1.8.0
  - @nifrajs/client@1.8.0
  - @nifrajs/schema@1.8.0
  - @nifrajs/mcp@1.8.0
  - @nifrajs/runner@1.8.0
  - create-nifra@1.8.0

## 1.7.0

### Patch Changes

- 9f23e90: Fix `nifra build --target static` producing pages that render but never hydrate. The prerender pass hardcoded a placeholder client entry, but the real bundle is content-hashed - so the prerendered HTML's hydration `<script src>` 404'd and every control was inert. `BuildTargetOptions.prerenderApp` is now a factory `(client: BuildManifest) => app` invoked with the completed client build, so the emitted `<script src>` uses the real hashed entry (plus the same styles / route-preload the SSR targets use). A regression test asserts the static HTML references the emitted hashed entry and that the file exists under `/assets`. Breaking only for code calling `buildTarget("static", …)` directly (pass a factory instead of a prebuilt app); `nifra build --target static` users just get working hydration.
- Updated dependencies [bd95181]
- Updated dependencies [9f23e90]
  - @nifrajs/core@1.7.0
  - @nifrajs/web@1.7.0
  - @nifrajs/client@1.7.0
  - @nifrajs/schema@1.7.0
  - @nifrajs/mcp@1.7.0
  - @nifrajs/runner@1.7.0
  - create-nifra@1.7.0

## 1.6.0

### Patch Changes

- @nifrajs/client@1.6.0
- @nifrajs/core@1.6.0
- @nifrajs/mcp@1.6.0
- @nifrajs/runner@1.6.0
- @nifrajs/schema@1.6.0
- @nifrajs/web@1.6.0
- create-nifra@1.6.0

## 1.5.0

### Minor Changes

- 1ac2fde: API breaking-change gate: `snapshotRoutes` + `diffRouteSnapshots` in `@nifrajs/core/diff` (direction-aware - a new required request field or a removed response field breaks; widening a request enum or adding a response field doesn't; fails closed on anything unprovable), and `nifra snapshot` / `nifra diff <baseline>` CLI commands that exit non-zero on breaking changes for CI.

### Patch Changes

- Updated dependencies [1ac2fde]
- Updated dependencies [bd3433f]
- Updated dependencies [70aa836]
  - @nifrajs/core@1.5.0
  - @nifrajs/schema@1.5.0
  - @nifrajs/client@1.5.0
  - @nifrajs/web@1.5.0
  - @nifrajs/mcp@1.5.0
  - @nifrajs/runner@1.5.0
  - create-nifra@1.5.0

## 1.4.0

### Patch Changes

- 4d25970: Add one fail-open request-observation lifecycle shared by tracing, agent telemetry, and DevTools; secured development tooling; contract-based mock responses; validator-neutral schema/route reflection; executable render and storage adapter conformance modules; optional storage pagination/signing/copy capabilities; and metadata-preserving local file storage.
- Updated dependencies [4d25970]
  - @nifrajs/core@1.4.0
  - @nifrajs/schema@1.4.0
  - @nifrajs/web@1.4.0
  - @nifrajs/client@1.4.0
  - @nifrajs/mcp@1.4.0
  - @nifrajs/runner@1.4.0
  - create-nifra@1.4.0

## 1.3.1

### Patch Changes

- 578da89: fix(cli): refresh the `nifra mcp` types/examples corpus for the 1.3.0 API + gate it

  `@nifrajs/cli` bundles the MCP corpus (`docs/types.json` / `examples.json`) behind `nifra_types` and
  `nifra_context`. It shipped **stale in 1.3.0** - the release regenerated `api-reference.md` + the LLM cards
  but not this corpus - so agents couldn't see `server().tool()` / `.resource()` / `.prompt()`,
  `onValidationError`, `RouteSchema.errors`, `ToolAnnotations`, or `generateLlmsTxt` via MCP. Regenerated.

  To prevent recurrence: `changeset:publish` now runs `gen:llms` after the build, so every published tarball
  carries a corpus regenerated from that exact build - the corpus can no longer ship stale regardless of what's
  committed.

  - @nifrajs/client@1.3.1
  - @nifrajs/mcp@1.3.1
  - @nifrajs/runner@1.3.1
  - @nifrajs/schema@1.3.1
  - @nifrajs/web@1.3.1
  - create-nifra@1.3.1

## 1.3.0

### Minor Changes

- 9f8d2aa: feat(cli): `nifra_check` / `nifra_test` MCP tools accept a `dir` to scope a subdirectory

  The MCP server runs at the project root, so `nifra check` / `nifra test` always ran from there - no way to
  target one app in a monorepo (a common pain: the root holds a builder + generated apps, but you want to
  check just `app/`). Both tools now take an optional `dir` (relative to the root, e.g. `"app"` or
  `"packages/api"`); the check/test runs against that subtree. Path-traversal-guarded - a `dir` that climbs
  out of the root (`../`, an absolute path elsewhere) is rejected, not run.

- 4a4b1c4: feat: `server().resource()` / `.prompt()` - app-declared MCP resources & prompts

  Completing the MCP trio alongside `.tool()`: an app can now expose its own MCP **resources**
  (`.resource(uri, { name, description?, mimeType? }, read)`) and **prompts** (`.prompt(name, { description,
arguments? }, handler)`). `nifra mcp` surfaces them in `resources/list` + `resources/read` and `prompts/list`

  - `prompts/get` (namespaced per app in a monorepo). The `read`/`handler` closures run in the app process, so
    they capture whatever app state they need - no HTTP round-trip.

### Patch Changes

- Updated dependencies [4a4b1c4]
- Updated dependencies [4a4b1c4]
  - @nifrajs/mcp@1.3.0
  - @nifrajs/schema@1.3.0
  - @nifrajs/web@1.3.0
  - @nifrajs/client@1.3.0
  - @nifrajs/runner@1.3.0
  - create-nifra@1.3.0

## 1.2.2

### Patch Changes

- 281844e: fix(cli): `nifra check` respects `.gitignore` and bounds the MCP result

  Two fixes so `nifra check` (and the `nifra_check` MCP tool) can't drown in a repo full of generated apps:

  - **Scanner honours `.gitignore`** - `walkSource` now filters candidates through one batched
    `git check-ignore`, so a gitignored generated/build tree isn't walked. A repo that gitignores, e.g., a
    238-app generated-output dir went from a **52 MB** check result to ~130 KB. Degrades to the built-in
    ignore list (node_modules/dist/…) when there's no git repo - never throws.
  - **`nifra_check` MCP tool caps its output** - `collectCheckResult` gains `maxDiagnostics` (the tool sets 100) and reports `truncated: { shown, total }`, so a huge project can't emit an MCP message large enough
    to break the stdio transport (`-32000: Connection closed`). `ok` still reflects the FULL set; the CLI
    terminal / `--json` output stays unbounded.
  - @nifrajs/client@1.2.2
  - @nifrajs/mcp@1.2.2
  - @nifrajs/runner@1.2.2
  - @nifrajs/schema@1.2.2
  - @nifrajs/web@1.2.2
  - create-nifra@1.2.2

## 1.2.1

### Patch Changes

- Updated dependencies [c3ebd73]
  - @nifrajs/web@1.2.1
  - @nifrajs/client@1.2.1
  - @nifrajs/mcp@1.2.1
  - @nifrajs/runner@1.2.1
  - @nifrajs/schema@1.2.1
  - create-nifra@1.2.1

## 1.2.0

### Patch Changes

- @nifrajs/client@1.2.0
- @nifrajs/schema@1.2.0
- @nifrajs/web@1.2.0
- @nifrajs/mcp@1.2.0
- @nifrajs/runner@1.2.0
- create-nifra@1.2.0

## 1.1.0

### Patch Changes

- Updated dependencies [9905f7f]
- Updated dependencies [17e57c4]
- Updated dependencies [37d2383]
  - create-nifra@1.1.0
  - @nifrajs/schema@1.1.0
  - @nifrajs/web@1.1.0
  - @nifrajs/client@1.1.0
  - @nifrajs/mcp@1.1.0
  - @nifrajs/runner@1.1.0

## 1.0.0

### Minor Changes

- 5673ff1: `nifra_types` - a new MCP tool that returns the **exact TypeScript** of any exported `@nifrajs/*` symbol (interface, type, class, function, const). Each signature is generated at build time from the package's built `.d.ts` with the TS compiler - the literal declaration, complete and authoritative, never prose and never truncated - and shipped inside `@nifrajs/cli` (`docs/types.json`), so it works offline and on every transport (stdio, HTTP, the edge `/mcp`).

  This closes the gap that made agents fall back to reading `.d.ts`: when an agent needs the precise shape of a type (`RateLimitStore`, `RouteSchema`, a function signature), `nifra_types({ name })` returns the literal block. The tool description makes the completeness explicit ("the source of truth - do NOT read `.d.ts`"), and `nifra_docs` now points at it for exact types. `nifra_examples_app` on the public docs MCP, and the `@nifrajs/cli/mcp` self-host surface, both expose it too (`TypeEntry` is re-exported).

### Patch Changes

- c099d5f: Add `@nifrajs/mcp` - build MCP servers, and **MCP Apps** (interactive `ui://` widgets, SEP-1865), for a nifra app.

  MCP tools have only ever returned text. MCP Apps lets a tool return **interactive UI**: a tool links a `ui://` resource (MIME `text/html;profile=mcp-app`); the host renders it in a sandboxed iframe and bridges it to the server over MCP-JSON-RPC-on-`postMessage`. `@nifrajs/mcp` ships:

  - The transport-agnostic JSON-RPC core (`handleRpc`, shared with `@nifrajs/cli`'s dev MCP) extended for MCP Apps - `structuredContent`, `_meta.ui.resourceUri`, and the `io.modelcontextprotocol/ui` capability.
  - `respondMcpHttp` - a Web `fetch` handler you mount at `POST /mcp`. nifra route handlers can return a raw `Response`, so mounting is one line per verb.
  - `defineMcpWidget` - author a `ui://` widget as one self-contained HTML doc with a tiny zero-dependency `postMessage` bridge inlined (`mcpApp.onData(render)` to render the host-pushed `structuredContent`; `mcpApp.callTool(...)` to re-invoke a tool through the host).
  - `defineMcpTool` + `createMcpServer` - wire tools to widgets and get a mountable server. See `examples/mcp-app/`.
  - `@nifrajs/mcp/react` - `reactWidget({ component })` authors a widget from a React component instead of an HTML string: the component is bundled for the browser (Bun.build) and re-renders on each `structuredContent` push over the bridge. `react`/`react-dom` resolve from the consumer; the core stays dependency-free.
  - **Host theming + render intent** (see `THEMING.md`). `defineMcpTool({ intent })` adds `_meta.ui.intent` (`table`/`list`/`form`/…) so a generative host renders `structuredContent` with its own themed component. For iframe widgets, the bridge handles a `ui/notifications/theme` push and auto-applies the host's shadcn/Tailwind semantic tokens (`--primary`, `--card`, `--border`, `--radius`, …) to the widget root - so a widget that styles with `hsl(var(--primary))` matches the embedding app with zero extra code.

  `@nifrajs/cli`'s MCP protocol core moved into `@nifrajs/mcp` (the CLI re-exports it); behavior is unchanged - a tool whose handler returns a plain `string` behaves exactly as before. nifra's own public docs MCP (nifra.dev `/mcp`) now also dogfoods this - `nifra_examples_app` renders the examples as an interactive widget.

- bb31594: Surface `@nifrajs/middleware` where agents look. The `nifra_context` conventions (and a scaffolded app's `AGENTS.md`) now carry a one-line pointer: cross-cutting concerns - rate limiting (`429`), CORS, security headers, body limits, auth, CSRF, IP restriction, caching, compression - are `app.use(...)` plugins in `@nifrajs/middleware`; call `nifra_docs("middleware")` for the full list. So an agent setting up routes finds the built-in middleware (it already shipped) without having to think to search for it.
- de9675b: Pre-1.0 security hardening pass. A framework-wide audit found no critical/high issues; these close the medium/low items it surfaced.

  - **`cache()` - no cross-user leak by default.** A `200` to a request bearing `Authorization`/`Cookie` is no longer stored (and replayed to other users) unless the response is explicitly `Cache-Control: public`/`s-maxage` (RFC 9111 §3.5). Opt back in per cache with `cacheAuthenticated: true` for a route that's identical for every caller.
  - **`idempotency()` - route-scoped keys + a `key` hook.** The default store key is now scoped by method+path, so the same `Idempotency-Key` on a different endpoint can't collide and replay another resource's response. Added a `key(req, header)` option to scope by principal (e.g. user id). Method matching normalized to upper-case.
  - **`etag()` - a `304` no longer carries the `200`'s `Content-Length`/`Content-Type`.**
  - **`@nifrajs/core` - inbound WebSocket frames are capped** when serving on Bun (`listen()`): frames over `wsMaxPayloadBytes` (default `maxBodyBytes`, 1 MB) are rejected by the runtime before reaching a handler, so a huge frame can't be buffered/parsed into memory. New `ServerOptions.wsMaxPayloadBytes`.
  - **`@nifrajs/core` - WebSocket routes are same-origin by default (CSWSH).** A `ws()` route with no `allowedOrigins` now rejects a **cross-origin browser** handshake (an `Origin` whose host differs from the request's) with `403` - closing cross-site WebSocket hijacking, since browsers send cookies on WS handshakes and don't apply CORS. Non-browser clients (no `Origin`) and same-origin browsers are unaffected. **Breaking** for a route that served a cross-origin browser without declaring `allowedOrigins`: set `allowedOrigins` to the permitted origins (or `() => true` for a genuinely public socket).
  - **`@nifrajs/node` - static file handler** now adds `X-Content-Type-Options: nosniff` and re-checks the real path (symlink containment) before streaming, matching the image server.
  - **`@nifrajs/mcp` - widget bridge** now rejects `postMessage` events whose source isn't the parent window (including null-source synthetic events), closing a spoofing gap the previous guard left open.
  - **`@nifrajs/cli` - the MCP `nifra_run`/`nifra_ws` `entry` arg** is kept inside the project root, so a crafted `entry` can't import/execute a module outside the project.

- a001558: **MCP warm worker survives a single per-request cancel.** The warm `nifra_run`/`nifra_render` worker is shared across concurrent calls (its `pending` map is id-keyed so several requests can be outstanding at once). Cancelling one request used to kill the whole worker process, which rejected every other in-flight request and forced a cold rebuild - defeating the warm reuse + concurrency the tool is built for. A per-request cancel now drops only that request and leaves the worker hot; it's still replaced on file change as before.
- Updated dependencies [f1f0e18]
- Updated dependencies [c099d5f]
- Updated dependencies [bb31594]
- Updated dependencies [3efb7cd]
- Updated dependencies [de9675b]
  - @nifrajs/client@1.0.0
  - @nifrajs/web@1.0.0
  - @nifrajs/mcp@1.0.0
  - create-nifra@1.0.0
  - @nifrajs/schema@1.0.0
  - @nifrajs/runner@1.0.0

## 1.0.0-beta.4

### Patch Changes

- Updated dependencies [5181a35]
  - create-nifra@1.0.0-beta.4
  - @nifrajs/client@1.0.0-beta.4
  - @nifrajs/runner@1.0.0-beta.4
  - @nifrajs/schema@1.0.0-beta.4
  - @nifrajs/web@1.0.0-beta.4

## 1.0.0-beta.3

### Patch Changes

- @nifrajs/client@1.0.0-beta.3
- @nifrajs/runner@1.0.0-beta.3
- @nifrajs/schema@1.0.0-beta.3
- @nifrajs/web@1.0.0-beta.3
- create-nifra@1.0.0-beta.3

## 0.1.0-beta.2

### Patch Changes

- Updated dependencies [5018546]
  - @nifrajs/web@0.1.0-beta.2
  - @nifrajs/client@0.1.0-beta.2
  - @nifrajs/runner@0.1.0-beta.2
  - @nifrajs/schema@0.1.0-beta.2
  - create-nifra@0.1.0-beta.2
