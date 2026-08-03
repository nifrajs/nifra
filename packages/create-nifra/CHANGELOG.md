# create-nifra

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
