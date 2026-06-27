# create-nifra

## 1.0.0-beta.4

### Patch Changes

- 5181a35: Pin the generated MCP launch command to an exact `@nifrajs/cli` version (`bunx @nifrajs/cli@<version> mcp`) in `.mcp.json` / `.cursor/mcp.json` / `AGENTS.md`.

  `bunx` keys its cache on the exact version spec. An unpinned spec resolves to the `latest` tag once, then `bunx` reuses that cached copy on every later spawn without re-checking the registry — so an editor that once launched an older `@nifrajs/cli` keeps respawning the stale binary even after a newer one is published, and the MCP server silently runs old code (e.g. without monorepo detection). Pinning the exact version makes the version part of the cache key, so each release fetches fresh. `scripts/version.ts` keeps the pin in lockstep with the published version. Re-run `nifra init-agents` to repin an existing app.

## 1.0.0-beta.3

## 0.1.0-beta.2
