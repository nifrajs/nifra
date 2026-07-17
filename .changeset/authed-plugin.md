---
"@nifrajs/better-auth": minor
---

Add `authed()` - a session-to-principal plugin that threads a fail-closed, non-null `c.principal` onto every downstream handler.

- **`authed(auth, options?)`** - `server().use(authed(auth))` derives `c.principal` (`{ user, userId, sessionId, tenantId? }`) for subsequent routes. A missing or invalid session short-circuits the request (`401` JSON, or a `302` to `options.redirectTo`) before any handler runs, so the guard can't be forgotten. Because the principal is threaded as a non-null context field, `c.principal.user` / `c.principal.userId` are typed with no non-null assertion. Works inline (`.get(...)`) and contract-first (pass `server().use(authed(auth))` as the app to `implement`, and the pre-applied derive reaches the contract's handlers).

- **`requirePrincipal(auth, request, options?)`** - the standalone guard `authed()` is built on: resolves the session, maps it to a `Principal`, or throws a `Response` (`401`/`302`, or `403` when `requireTenant` is set and no tenant resolves). Reuses `requireSession`'s no-session throw path.

- **Options**: `requireTenant` (no resolvable tenant is a `403`; also narrows `tenantId` to a required `string` in the returned type), `redirectTo` (same-origin `302` instead of `401`), and `tenantOf` (custom tenant resolver; defaults to `user.tenantId ?? user.orgId`).

- New exported types: `Principal`, `AuthedOptions`, `PrincipalFor`, `SessionUserOf`, `WithPrincipal`.

The plugin owns the session-to-principal wiring only; binding the principal to a data-access scope stays in application code (this package adds no storage or database logic).
