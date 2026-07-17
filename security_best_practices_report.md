# Security best-practices review

Date: 2026-07-17

## Executive summary

The post-feedback code was reviewed across the newly changed HTTP/WebSocket core, typed client,
Better Auth integration, OTLP exporter, CLI scanners, MCP bridge/widgets, web framework adapters, and
release tooling. No unresolved high- or medium-severity security defect remains in the reviewed scope.

The live dependency audit initially found three development-tool advisories. They were fixed by pinning
patched transitive versions, and `bun audit` now reports **No vulnerabilities found**. The repository's
full test, build, clean-consumer smoke, Nifra JSON, and publish-shape gates also pass.

## Fixed finding

### S-01 — Vulnerable development-tool transitive dependencies (fixed)

- Severity: Moderate (two advisories), Low (one advisory)
- Affected paths: Drizzle Kit / Vite to `esbuild`, and Changesets to `js-yaml`
- Evidence: root overrides now select `esbuild@0.28.1` and `js-yaml@3.15.0` in
  [`package.json`](package.json#L56-L60), and the lockfile contains no vulnerable copies.
- Advisories: [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99),
  [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr), and
  [GHSA-h67p-54hq-rp68](https://github.com/advisories/GHSA-h67p-54hq-rp68).
- Verification: clean `bun audit`; Changesets config/status, Drizzle config/schema export, Vite, tsx,
  and esbuild command paths all pass.

## Verified trust boundaries

- WebSocket cross-site request protection is secure by default: cross-origin browser upgrades are
  rejected unless an exact allowlist or predicate is configured
  ([`packages/core/src/server/websocket.ts`](packages/core/src/server/websocket.ts#L137-L149),
  [`packages/core/src/server/server.ts`](packages/core/src/server/server.ts#L1701-L1714)).
- Query and cookie dictionaries use null-prototype objects, preventing inherited `__proto__` keys from
  becoming application state ([`packages/core/src/server/query.ts`](packages/core/src/server/query.ts#L43),
  [`packages/core/src/server/cookies.ts`](packages/core/src/server/cookies.ts#L57-L60)).
- Better Auth redirects accept only same-origin paths, and tenant-required principals fail closed when
  the tenant is missing or blank
  ([`packages/better-auth/src/index.ts`](packages/better-auth/src/index.ts#L105-L112),
  [`packages/better-auth/src/index.ts`](packages/better-auth/src/index.ts#L231-L248)).
- The MCP iframe receiver accepts messages only from its embedding parent. Its `"*"` target origin is
  intentional because MCP hosts have no single known origin and widgets run in sandboxed iframes; the
  parent is the protocol trust boundary
  ([`packages/mcp/src/bridge.ts`](packages/mcp/src/bridge.ts#L92-L100)).
- Raw HTML content components remain explicit trusted-content sinks and document that user HTML must be
  sanitized before use ([`packages/web-react/src/content.ts`](packages/web-react/src/content.ts#L1-L8)).
- The browser playground's `new Function` executes only code the local user entered in their own tab;
  rendered results use `textContent`, not HTML. Its backend Copilot request now uses a type-only backend
  import and the typed client ([`site/islands/playground.client.ts`](site/islands/playground.client.ts#L8-L19),
  [`site/islands/playground.client.ts`](site/islands/playground.client.ts#L244-L268)).

## Operational notes

- Security headers, body limits, authentication, CSRF, rate limiting, and trusted proxy/IP handling are
  opt-in middleware or server policy. Applications must enable the controls appropriate to their public
  routes and deployment topology.
- `Content`/raw-HTML APIs and MCP host messages are explicit trust-boundary APIs. Passing untrusted HTML
  without sanitization or embedding a widget in an untrusted parent violates their documented contract.
- Re-run `bun audit`, `bun run check`, `bun run smoke`, and `bun run check:publish` before release.
