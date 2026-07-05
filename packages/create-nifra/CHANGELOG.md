# create-nifra

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
