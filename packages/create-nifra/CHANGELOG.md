# create-nifra

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
