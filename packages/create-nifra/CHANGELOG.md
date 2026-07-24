# create-nifra

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
    before reading `res.data` — un-narrowed `data` is `{}` under the typed client, so the old
    `res.data?.count` was a compile error on a fresh scaffold.
  - Demo backends now lock output shapes with `response` schemas (`t.object(...)`), per the
    AGENTS.md doctrine the templates themselves ship.
  - `template-isr` now includes `@nifrajs/cli` in devDependencies so a scaffolded app can run
    its own `nifra check` done-gate.
  - `--link` computes `file:` paths from realpaths — a symlinked segment (macOS tmpdir
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

- 9905f7f: feat(create-nifra): `--template fullstack` — a batteries-included starter

  `bun create nifra my-app --template fullstack` scaffolds an app that already wires the packages a real
  backend needs on top of core: cursor pagination (`t.pageQuery` / `t.paginated` / `paginate`), background
  jobs (`@nifrajs/jobs`), a single-flight TTL cache (`@nifrajs/cache`), and blob storage (`@nifrajs/storage`)
  — over a `notes` domain you swap for your DB. Ships with tests exercising each. Complements the existing
  `api`, `site`, and `isr` templates.

## 1.0.0

### Patch Changes

- bb31594: Surface `@nifrajs/middleware` where agents look. The `nifra_context` conventions (and a scaffolded app's `AGENTS.md`) now carry a one-line pointer: cross-cutting concerns — rate limiting (`429`), CORS, security headers, body limits, auth, CSRF, IP restriction, caching, compression — are `app.use(...)` plugins in `@nifrajs/middleware`; call `nifra_docs("middleware")` for the full list. So an agent setting up routes finds the built-in middleware (it already shipped) without having to think to search for it.

## 1.0.0-beta.4

### Patch Changes

- 5181a35: Pin the generated MCP launch command to an exact `@nifrajs/cli` version (`bunx @nifrajs/cli@<version> mcp`) in `.mcp.json` / `.cursor/mcp.json` / `AGENTS.md`.

  `bunx` keys its cache on the exact version spec. An unpinned spec resolves to the `latest` tag once, then `bunx` reuses that cached copy on every later spawn without re-checking the registry — so an editor that once launched an older `@nifrajs/cli` keeps respawning the stale binary even after a newer one is published, and the MCP server silently runs old code (e.g. without monorepo detection). Pinning the exact version makes the version part of the cache key, so each release fetches fresh. `scripts/version.ts` keeps the pin in lockstep with the published version. Re-run `nifra init-agents` to repin an existing app.

## 1.0.0-beta.3

## 0.1.0-beta.2
