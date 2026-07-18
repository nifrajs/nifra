# @nifrajs/better-auth

## 2.0.0

### Minor Changes

- 6faef58: Add `authed()` - a session-to-principal plugin that threads a fail-closed, non-null `c.principal` onto every downstream handler.

  - **`authed(auth, options?)`** - `server().use(authed(auth))` derives `c.principal` (`{ user, userId, sessionId, tenantId? }`) for subsequent routes. A missing or invalid session short-circuits the request (`401` JSON, or a `302` to `options.redirectTo`) before any handler runs, so the guard can't be forgotten. Because the principal is threaded as a non-null context field, `c.principal.user` / `c.principal.userId` are typed with no non-null assertion. Works inline (`.get(...)`) and contract-first (pass `server().use(authed(auth))` as the app to `implement`, and the pre-applied derive reaches the contract's handlers).

  - **`requirePrincipal(auth, request, options?)`** - the standalone guard `authed()` is built on: resolves the session, maps it to a `Principal`, or throws a `Response` (`401`/`302`, or `403` when `requireTenant` is set and no tenant resolves). Reuses `requireSession`'s no-session throw path.

  - **Options**: `requireTenant` (no resolvable tenant is a `403`; also narrows `tenantId` to a required `string` in the returned type), `redirectTo` (same-origin `302` instead of `401`), and `tenantOf` (custom tenant resolver; defaults to `user.tenantId ?? user.orgId`).

  - New exported types: `Principal`, `AuthedOptions`, `PrincipalFor`, `SessionUserOf`, `WithPrincipal`.

  The plugin owns the session-to-principal wiring only; binding the principal to a data-access scope stays in application code (this package adds no storage or database logic).

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

## 1.12.0

## 1.11.0

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

## 1.0.0

### Patch Changes

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

- @nifrajs/core@0.1.0-beta.2
