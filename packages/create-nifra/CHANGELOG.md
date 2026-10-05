# create-nifra

## 4.0.0

### Major Changes

- 5f1f3d8: feat(create-nifra)!: every template keeps its server code in `backend/`

  - The `api` and `batteries` templates keep their app in `backend/` (`backend/app.ts`,
    `backend/index.ts`), and `backend/app.ts` exports `backend` and `type Backend`, so `nifra contracts`
    and `nifra sdk` find it without configuration.
  - `--db` writes its data layer to `backend/db/` (the Drizzle config, scripts and `.gitignore` entries
    point there), and `--auth` writes `backend/auth.ts`. Every module a scaffold writes is in a zone,
    so a site's route backends can import them.
  - The `isr` template's Workers entry and local Bun server are `backend/worker.ts` and
    `backend/dev-server.ts`.

- 6c978a1: feat(create-nifra)!: a site scaffold picks one deploy target

  - `--target bun|node|deno|cloudflare|vercel` (default `bun`) chooses where the site deploys.
    `--deploy` is refused with that name.
  - `--docker` adds a Dockerfile and `.dockerignore` for `bun` or `node`.
  - The scaffold carries no hand-written server entry or build script. `nifra build` generates the
    target's entry, and `nifra.config.ts` exports the `target` (`nifra target <t>` switches it).
  - Only the target's own config file is written (`deno.json` for Deno, `wrangler.toml` for
    Cloudflare), plus `start` / `deploy` scripts for it. `--ci` deploys the chosen target.

- 214d674: feat(create-nifra)!: site scaffolds use the zoned layout - `backend/app.ts`, `backend/framework.ts`,
  and each route's loader and action in its `x.backend.ts`.

### Minor Changes

- c3057ee: feat: AGENTS.md is the one copy of an app's agent guidance

  A scaffold and `nifra init-agents` write `AGENTS.md` plus a pointer to it for each agent:
  `CLAUDE.md` and `GEMINI.md` import it, `.cursor/rules/nifra.mdc` is an always-applied Cursor rule
  that attaches it, and `.github/copilot-instructions.md` names it. None of them carries guidance of its
  own, so they cannot drift apart. A web app's `AGENTS.md` gains a "Project structure" section on the
  frontend/backend zones the build enforces, and `nifra init-agents` appends it to an app with `routes/`.

- a0cfffa: `export const clientIp = "platform"` in `nifra.config.ts` makes a `cloudflare` or `vercel` build read `c.clientIp` from the header that platform's edge overwrites (`cf-connecting-ip`, `x-real-ip`), so per-caller middleware such as `rateLimit` works there. Without it an edge build still has no caller address; Bun, Node and Deno builds use the socket peer either way. `buildTarget` and `generateServerEntry` take the same `clientIp` option. Site scaffolds declare it.

### Patch Changes

- a8b33bc: The Solid and Svelte compiler plugins live on their `/plugin` subpaths, and each adapter root exports only the render adapter.

  - `solidBunPlugin` is imported from `@nifrajs/web-solid/plugin`, matching `@nifrajs/web-svelte/plugin` and `@nifrajs/web-vue/plugin`.
  - `@nifrajs/web-solid` and `@nifrajs/web-svelte` link no build-time or `node:` module, so a server or edge bundle that imports the adapter builds under edge resolve conditions (Cloudflare Workers, Vercel Edge, Deno).
  - Solid site scaffolds import the plugin from the subpath.

  Breaking: `solidBunPlugin` is no longer exported from `@nifrajs/web-solid`, nor `svelteBunPlugin` from `@nifrajs/web-svelte`. `nifra fix --code NF-C005` rewrites those imports.

- a0cfffa: Cloudflare scaffolds (a site with `--target cloudflare`, and the ISR template) declare `compatibility_date = "2025-04-01"`, the first date at which `nodejs_compat` fills `process.env` from the project's variables, so `NIFRA_ALLOW_MEMORY_RATE_LIMIT` reaches the starter's rate limit. Their local-only commands (`bun run start` for the site, `bun run dev` for ISR) set it for the one local process; a deploy still refuses to start until the variable is set.
- 9868241: `bun create nifra . --force` scaffolds into the current directory on Windows.
- 6ce7975: The `AGENTS.md` a new app ships with names every route schema slot (`body`, `query`, `params`, `headers`, `cookies`) and shows a `params` schema validating and coercing a path param, where it used to say path params and headers could not be declared in the route schema.
- 7669f56: A project whose name has capitals, `_`, or `.` (`MyApp`, `my_app`) gets a Docker image tag, a `wrangler.toml` `name`, and Cloudflare Pages and Deno Deploy CI project names in lowercase letters, digits, and `-`, the form those platforms take. `package.json` keeps the name as given.
- a77b341: The `site` and `isr` templates now ignore `.env` and `.env.*` (keeping `.env.example`), as the `api` and `batteries` templates already did.
- ce169a2: `create-nifra` refuses a destination that already holds files unless `--force` is given, for every template. Before, the site template scaffolded into such a directory and replaced its `.gitignore`, `AGENTS.md`, `CLAUDE.md` and agent/MCP config files. An existing empty directory is now accepted without `--force`, and `bun create nifra . --force` names the project after the current directory instead of rejecting the name `.`.
- b83d400: The Vue site starter keeps its global stylesheet in an SFC `<style>` block, and the Preact starter renders its stylesheet unescaped, so both hydrate with no mismatch and the server-rendered page has its fonts before the client loads.
- 29c6c94: feat(middleware): client-IP default keys and a CSRF form field

  `rateLimit()` without `key`, `header`, or `trustedProxies` keys each bucket on the caller IP the
  server resolved: the socket peer, or the app's `server({ clientIp })` trust declaration behind a
  proxy. It no longer throws at construction, so the scaffolded backend templates, which pass only
  `store`, `max`, and `windowMs`, start. A request with no resolvable caller IP gets 500
  `rate_limit_key_unavailable`. A custom `key` receives the platform as its second argument.

  `ipRestriction()` without `clientIp`, `header`, or `trustedProxies` judges the same resolved caller
  IP, and denies a request that has none. A custom `clientIp` receives the platform as its second
  argument.

  Both read an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`, how Bun and Node report an IPv4 peer on
  their default listener) as the IPv4 address it carries, so IPv4 `allow`/`deny` rules match it; a rule
  may also be written in that form (`::ffff:10.0.0.0/104`). `rateLimit()` counts an IPv6 caller by its
  `/64`, however the key was derived.

  `csrf({ field })` also accepts the token from a form field in an
  `application/x-www-form-urlencoded` or `multipart/form-data` body, for plain HTML forms that cannot
  set a header. Bodies over `fieldMaxBytes` (default 64 KiB) are not read for the field, file parts
  never count as the token, and the body stays readable by the route. Keep the Origin check on when
  using a field.

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

- 4936309: Pin generated CI workflows to the repository's current Bun release.
- fb7c5b3: Site and ISR scaffolds declare `@types/bun` and load its ambient types. The starter database rules in `nifra.assurance.ts` are optional, so an app without a database passes `nifra assure`; an import that matches a rule still grants its capabilities.

  The ISR template's client build no longer copies `public/` into its own output directory.

- 715186c: `--auth better-auth` scaffolds ship no placeholder secret.

  - `.env.example` leaves `BETTER_AUTH_SECRET` empty. Locally, better-auth falls back to its development secret; in production it refuses to start until a secret is set.
  - The generated `backend/auth.ts` refuses a `BETTER_AUTH_SECRET` shorter than 32 characters in production, where better-auth itself only logs a warning.

- d1e2f50: feat: starters type their routes with the generated `./+types`

  The site and ISR starters type the landing page as `import type { Route } from "./+types/index"`:
  `props: Route.ComponentProps` in the page, `Route.LoaderArgs` / `Route.ActionArgs` in its backend
  half. `data` is the `loaderOutput` schema's type, which is what reaches the browser. A scaffold
  ships its `.nifra/types`, so the types resolve right after `bun install`, before any nifra command
  has run. The Svelte starter types its `$props()` the same way, and the Vue starter types the props it
  declares from `Route`. Svelte and Vue scaffolds include their `.svelte` / `.vue` files in
  `tsconfig.json`, so svelte-check, vue-tsc and the editor type-check routes. `nifra_frontend`'s
  loader-typing guidance now points at the route types.

- 784d772: `testClient` calls now come from `127.0.0.1`, as a socket peer's would, so middleware keyed on the caller's address, such as `rateLimit()`, runs in tests as it does behind a listener. Pass `clientIp` to test another address. `inProcessClient` calls made outside a page render still carry no address.

  The batteries template declares `@nifrajs/middleware`, and its tests pass on a fresh scaffold.

- e32268d: fix(web): portable public-directory serving and required endpoint secrets

  `publicDir()` now serves files on Node and Deno as well as Bun, sets `content-type` from the file
  extension, sends `x-content-type-options: nosniff`, and never serves dot-prefixed paths other than
  `/.well-known/`.

  `revalidateEndpoint()` and `previewEndpoint()` throw at construction when `secret` is empty or
  missing. The ISR starter answers 404 on its revalidate route until `REVALIDATE_SECRET` is set.

## 3.5.0

## 3.4.0

## 3.3.0

## 3.2.0

## 3.1.0

## 3.0.0

## 2.14.1

## 2.14.0

## 2.13.0

## 2.12.1

## 2.12.0

### Patch Changes

- 7dd3f28: The project name is validated before any file is copied. It is substituted into generated deploy
  scripts that a shell runs (`--name NAME`), so a directory name carrying shell metacharacters, spaces,
  or a leading `-` used to reach those scripts intact. The accepted set is npm's own for an unscoped
  name - letters, digits, `.`, `-`, `_`, starting with a letter or digit, up to 214 characters - so
  ordinary names like `MyApp` still scaffold. Rejecting up front also means a bad name no longer leaves
  a half-written project directory behind.

  Every action in the generated CI workflows is pinned to a commit SHA rather than a mutable tag, so a
  scaffolded repo starts on the same footing this one uses.

## 2.11.0

## 2.10.0

## 2.9.1

## 2.9.0

## 2.8.2

## 2.8.1

## 2.8.0

## 2.7.1

## 2.7.0

### Minor Changes

- 7fd0fc7: The batteries-included backend starter is now `--template batteries` (background jobs, TTL cache, blob storage, cursor pagination on top of the `api` template), and it ships in the published package. `--template fullstack` no longer exists; asking for it explains the split: `site` is the full-stack (frontend + backend) template, `batteries` is the API starter. The README now documents all four templates, and the scaffolded `backend.ts` states its root-path convention: the CLI resolves `backend.ts` (like `routes/`, `framework.ts`, `nifra.config.ts`) from the project root - only that entry file is pinned there; merged feature modules can live anywhere.

## 2.6.1

## 2.6.0

## 2.5.0

## 2.4.0

### Patch Changes

- 06f4aaa: Build on `prepack` so the published package always ships its `dist` output - including the `create-nifra/agent-files` entry that `nifra init-agents` imports under Node.

## 2.3.0

### Minor Changes

- c8b79d7: `--db` scaffolds the data layer split by access, with a routes module that owns its own reach.

  `db/read.ts` and `db/write.ts` sit in front of the connection, and `db/read-routes.ts` registers a
  route importing only the read half. Merging it is one line.

  The shape is not decoration. `nifra check` computes what a route can reach from the module that
  registers it, following its imports; a route may not reach further than it declares, and a GET route
  may not declare a domain write at all. A module holding both halves therefore has GET routes with no
  legal declaration. Splitting reads from writes at the seam, and again at the routes, keeps every
  route's declaration equal to its reach - which is what the `authenticated-write` rule needs in order to
  mean anything.

  The generated write example is commented rather than live, and says what happens when you uncomment
  it: it fails `nifra assure` until authenticated, because the starter policy requires proof of who asked
  before anything writes business state.

- 82b2053: Every template composes its routes from feature modules, and the effect provenance firewall ships ARMED.

  `provenance.imports` now maps the database drivers and the `--db` seam, so a route that can reach a
  database without declaring it fails `nifra check`. Combined with the `authenticated-write` rule, the
  whole chain holds without anyone remembering anything:

  - a route that writes and declares nothing fails the check;
  - declare it, and the route fails assurance until it is authenticated;
  - only an authenticated write ships.

  Arming it required the app root to stop registering routes. Reach is computed from the module that
  REGISTERS a route, following that module's imports, so a root that both composes and registers hands
  every route in it the reach of everything merged there - and a GET route may not declare a domain write
  at all, leaving those routes with no legal declaration and no fix but to move. So `src/app.ts` (api,
  fullstack) and `backend.ts` (site, isr) merge and nothing else; the demo routes moved to `src/routes.ts`,
  `src/notes.ts`, `counter.ts` and `page.ts` beside them. Exports are unchanged - `app`, `backend`, `queue`
  and `wasIndexed` are all still imported from where they were.

  That is the shape a feature should take anyway: a module owns its store, its adapters and the routes
  over them, and a second feature with a database of its own gets its own file rather than a section.

- 26cec7d: A scaffolded app can run the gate it ships with.

  Every template writes `nifra.assurance.ts` - an armed policy that refuses an unauthenticated write, a
  mutation with no body schema, and a route reaching a database it never declared. None of them had a way
  to run it: no `check` script anywhere, and the two backend templates did not even depend on
  `@nifrajs/cli`, so `nifra check` was not on PATH without a manual install.

  Every template now has `"check": "nifra check"` and the CLI in devDependencies, and the generated
  GitHub workflow (`--ci github`) runs it before the build. A test asserts the invariant: a template that
  ships an assurance config must ship both.

- 7f55876: Every template declares its capabilities, so a scaffolded app can reach L2 of `nifra levels`.

  `nifra.assurance.ts` now carries a `capabilities` block defining `db.read` and `db.write`, and the
  `authenticated-write` rule matches `{ access: "write", zone: "domain" }` instead of naming `db.write`.
  Any write token added later - `payments.charge`, `orders.write` - is covered by that rule the day it is
  declared, without editing the policy.

  L2 was previously unreachable from a scaffold: the level requires a capability policy, no template
  shipped one, and writing one from scratch was the only way up. It is now one `nifra capabilities
snapshot` away.

  `provenance.imports` ships empty with a worked example and the one caveat that matters, which is that a
  route's reach is computed from the module that REGISTERS it, following its imports. A module that
  registers routes and imports a database gives every route in it database reach, and a GET route is
  refused a domain write outright - so turning the import firewall on wants a root that is pure
  composition, with effects owned by the modules underneath.

  The `isr` template gains a `nifra.assurance.ts`; it had none, which capped it at L0.

### Patch Changes

- cee03d7: The beacon wrapper stops breaking adapters that use `#private` fields, and the `--db` sample no longer
  collides with a template route.

  A `#` field's brand check is per-instance, so a Proxy that passes itself as the receiver throws
  `Cannot access invalid private field`. Getters broke on both views and methods broke on the unbound
  one - an adapter using `#` worked unwrapped and broke the moment you added beacons. Both proxies now
  read against the target, and the unbound one binds methods to it.

  The generated `db/read-routes.ts` registered `GET /notes`, which the fullstack template already
  registers. `nifra check` associates modules with routes by matching the registered path across your
  source, so that unmerged sample lent its `db.read` reach to a template route that never touches the
  database - failing the check on a fresh `create-nifra --template fullstack --db …`. The sample uses
  `/db/notes` now, and says why.

- 8807004: A scaffold's feature flags declare what they contribute instead of racing to write it.

  `--db`, `--auth` and `--deploy` each reached into the parsed `package.json` and spread themselves over
  it, in an order fixed by the line their handler sat on. Last writer won, silently. A preset that
  shadowed the scaffold's own `check` script would have removed the assurance gate from every project
  scaffolded with it, and nothing anywhere would have reported that.

  No shipped preset does that - all six were checked - which is the moment to add the rail rather than
  after someone adds the seventh. Each flag now states its contribution, and an undeclared collision is
  an error naming both sides. Replacing a key stays possible where it is the point: `--deploy` repoints
  the canonical `build` and `deploy` aliases at the chosen target, and says so.

- ea0a27f: A scaffolded project's `check` script runs the assurance gate it ships with, and the dev refusals cover
  extensionless modules.

  Every template ships an assurance config, and every template's `check` script ran `nifra check` only -
  so the policy was shipped, documented, and never executed by the command a project actually runs in CI.
  It now runs `nifra check && nifra assure`.

  `nifra dev --bun` refuses `.server` and `.fn` modules because Bun's dev bundler takes no plugins and
  would ship them whole. The refusal missed a module with no extension at all, which is the one shape a
  directory import produces.

- 35af9fe: A site scaffold is composed from one model instead of copied from five directories.

  `create-nifra --template site --framework <react|preact|vue|solid|svelte>` produces the same app it
  always did. What changed is where it comes from: thirteen of a site's twenty-six files are identical
  whatever you render with, eight are emitted from a framework model, and five are genuinely the
  framework's own.

  Five hand-maintained copies had already drifted, which is the argument for this rather than a
  consequence of it. `.vercel` was excluded from four `tsconfig.json` files and not React's, though
  `build-vercel.ts` writes there in all five. React's Vercel entry explains the Build Output API layout
  it emits and the three copies made later had dropped that. Vue's feature-flag defines are explained in
  its Cloudflare entry and nowhere else. Composing restores all of it.

  The `@nifrajs/*` range a scaffold installs is now one constant. It used to be a regex sweep across
  eight `package.json` files with nothing checking the result, and the release script's own comment
  warned that a missed bump ships templates installing the previous release. A test now fails when that
  constant drifts from the version being published.

  What is NOT generated is deliberate. `nifra.config.ts` explains why Solid wants a `solid` resolve
  condition and what `@preact/preset-vite` is; the routes are the app a reader opens first. That prose
  stays in files you can read and edit, because moving it into TypeScript string literals would put it
  somewhere strictly worse.

## 2.2.0

### Patch Changes

- 5f460db: Fix `nifra init-agents`, and explain rejected route parameters.

  `nifra init-agents` failed for every installed user with `Cannot find module 'create-nifra/agent-files'`.
  The `./agent-files` subpath resolves through the `bun` condition to `src/agent-files.ts`, which the
  published tarball did not contain - the package shipped `dist` and the templates only. It now ships
  that source file, so the subpath resolves from a real install. Reproduced from a packed 2.1.0 tarball
  before and after.

  An invalid route parameter now says why. Route grammar is per-segment - a segment is wholly static or
  wholly a parameter - so everything after the colon is the name, and `/v/:id.json` asks for a parameter
  literally called `id.json`. The previous `invalid parameter ":id.json"` read as a typo rather than a
  rule; the message now names the limitation and gives both ways out (`/v/:id/json`, or capture the whole
  segment and split it in the handler). Reserved names, an empty name, and a name that is invalid for
  some other reason each get their own explanation instead of sharing one.

  Note for anyone who has hit this: a segment that merely _contains_ a colon without starting with one,
  such as `/a/pre-:id`, is a literal static segment and captures nothing. That is deliberate - a colon is
  legal inside a URL path segment (`/v1/things:batchGet`) - and is now covered by a test that documents it.

## 2.1.0

## 2.0.0

### Minor Changes

- 202e758: Schema-typed MCP tools, and the default template demonstrates the contract.

  - `defineMcpTool` accepts `input`: a Standard Schema (nifra's `t`, zod, valibot, arktype, …) that
    validates every call's arguments before the handler runs and types the handler's `args`. Invalid
    arguments return an in-band `isError` result naming each issue, so a calling agent can correct
    and retry. Schemas that carry a JSON Schema (nifra's `t` does) become the advertised
    `inputSchema` automatically; an explicit `inputSchema` still overrides. The raw
    `inputSchema`-only form keeps working unchanged.
  - The `api` template's app now ships a `t`-validated route (body + response schemas) and its tests
    drive the app through `testClient` - the contract-first pitch is visible in the first file a new
    user opens, not just the docs.

### Patch Changes

- ade0c7a: Add a curated `@nifrajs/core/server` entry for the common HTTP runtime and dedicated subpaths for
  contracts, classification, cookies, logging, routing, Standard Schema, SEO, SSE, and webhooks. The
  package root remains backwards compatible, while new scaffolds and first-party runtime packages avoid
  eagerly parsing opt-in causality, invariant, manifest, reflection, capability, and assurance tooling.

## 1.13.0

## 1.12.0

## 1.11.0

### Patch Changes

- 80ed7b8: Fix fresh scaffolds failing their own `nifra check`, plus two scaffolding tooling defects:

  - All counter demo templates (site ×5 frameworks, isr): demo loaders now narrow on `res.ok`
    before reading `res.data` - un-narrowed `data` is `{}` under the typed client, so the old
    `res.data?.count` was a compile error on a fresh scaffold.
  - Demo backends now lock output shapes with `response` schemas (`t.object(...)`), per the
    AGENTS.md doctrine the templates themselves ship.
  - `template-isr` now includes `@nifrajs/cli` in devDependencies so a scaffolded app can run
    its own `nifra check` done-gate.
  - `--link` computes `file:` paths from realpaths - a symlinked segment (macOS tmpdir
    `/var/folders` → `/private/var/folders`) previously skewed the relative path and broke
    every linked dependency.
  - New regression suite `test/scaffold-check.test.ts`: static tier always asserts the
    template sources carry both contract fixes; live tier (`SMOKE_SCAFFOLD=1`) scaffolds for
    real, installs published packages, and runs `nifra check`.

## 1.10.0

## 1.9.1

## 1.9.0

## 1.8.0

## 1.7.0

## 1.6.0

## 1.5.0

## 1.4.0

## 1.3.1

## 1.3.0

## 1.2.2

## 1.2.1

## 1.2.0

## 1.1.0

### Minor Changes

- 9905f7f: feat(create-nifra): `--template fullstack` - a batteries-included starter

  `bun create nifra my-app --template fullstack` scaffolds an app that already wires the packages a real
  backend needs on top of core: cursor pagination (`t.pageQuery` / `t.paginated` / `paginate`), background
  jobs (`@nifrajs/jobs`), a single-flight TTL cache (`@nifrajs/cache`), and blob storage (`@nifrajs/storage`)

  - over a `notes` domain you swap for your DB. Ships with tests exercising each. Complements the existing
    `api`, `site`, and `isr` templates.

## 1.0.0

### Patch Changes

- bb31594: Surface `@nifrajs/middleware` where agents look. The `nifra_context` conventions (and a scaffolded app's `AGENTS.md`) now carry a one-line pointer: cross-cutting concerns - rate limiting (`429`), CORS, security headers, body limits, auth, CSRF, IP restriction, caching, compression - are `app.use(...)` plugins in `@nifrajs/middleware`; call `nifra_docs("middleware")` for the full list. So an agent setting up routes finds the built-in middleware (it already shipped) without having to think to search for it.

## 1.0.0-beta.4

### Patch Changes

- 5181a35: Pin the generated MCP launch command to an exact `@nifrajs/cli` version (`bunx @nifrajs/cli@<version> mcp`) in `.mcp.json` / `.cursor/mcp.json` / `AGENTS.md`.

  `bunx` keys its cache on the exact version spec. An unpinned spec resolves to the `latest` tag once, then `bunx` reuses that cached copy on every later spawn without re-checking the registry - so an editor that once launched an older `@nifrajs/cli` keeps respawning the stale binary even after a newer one is published, and the MCP server silently runs old code (e.g. without monorepo detection). Pinning the exact version makes the version part of the cache key, so each release fetches fresh. `scripts/version.ts` keeps the pin in lockstep with the published version. Re-run `nifra init-agents` to repin an existing app.

## 1.0.0-beta.3

## 0.1.0-beta.2
