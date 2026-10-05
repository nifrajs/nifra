# @nifrajs/better-auth

## 4.0.0

### Patch Changes

- 52bb49e: fix: carry authentication, evidence, and WebSocket boundary guarantees through the typed client and Better Auth integration
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

## 3.5.0

## 3.4.0

## 3.3.0

## 3.2.0

## 3.1.0

## 3.0.0

### Patch Changes

- f0fd370: The same-origin check behind `redirect()` and the guards' `redirectTo` now rejects the paths a URL parser resolves onto another origin, and lives in one place.

  A leading `/` that is not `//` is not sufficient to keep a destination on this origin. Under a special scheme a backslash parses as a path separator, and tab, CR and LF are stripped from the input before parsing, so `/\evil.example` and `/<TAB>/evil.example` both pass a `//` test and then resolve to the host `evil.example` - an open redirect reachable from any unvalidated `?next=` parameter. Both forms are now refused: `redirect()` throws as it already did for `//host`, and an auth guard falls back to its configured destination instead of honouring the value.

  New export `isSameOriginPath` from `@nifrajs/core/server`, which is the single implementation the three gates now share - a security predicate kept in three copies is three chances for one of them to be hardened alone. It answers about a path, so an absolute URL is false even when it names the current origin: the point of the gate is that the value never got to name a host at all.

  A percent-encoded backslash (`/%5Cevil.example`) is still a same-origin path, because that is what it resolves to.

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

## 2.14.1

## 2.14.0

## 2.13.0

## 2.12.1

## 2.12.0

## 2.11.0

## 2.10.0

## 2.9.1

## 2.9.0

## 2.8.2

## 2.8.1

## 2.8.0

## 2.7.1

## 2.7.0

## 2.6.1

## 2.6.0

### Patch Changes

- e6349e5: Security hardening across input parsing and code generation. Every regex that runs on caller-influenced input (URL paths, route patterns, stylesheet and SVG sources, manifest text) is now linear - no polynomial backtracking on adversarial input. SVG preamble stripping and tag removal can no longer splice removed delimiters into new markers. Static file serving rejects `..` traversal in the request form outright and confines the resolved path with a `relative()` containment check. Generated code embeds strings through an escaper that neutralizes `</script>` breakout and the U+2028/U+2029 line separators, and HTML entity decoding resolves `&amp;` last so double-encoded entities cannot double-unescape.

## 2.5.0

## 2.4.0

## 2.3.0

## 2.2.0

## 2.1.0

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
