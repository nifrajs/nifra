---
"@nifrajs/core": minor
"@nifrajs/web": patch
"@nifrajs/auth": patch
"@nifrajs/better-auth": patch
---

The same-origin check behind `redirect()` and the guards' `redirectTo` now rejects the paths a URL parser resolves onto another origin, and lives in one place.

A leading `/` that is not `//` is not sufficient to keep a destination on this origin. Under a special scheme a backslash parses as a path separator, and tab, CR and LF are stripped from the input before parsing, so `/\evil.example` and `/<TAB>/evil.example` both pass a `//` test and then resolve to the host `evil.example` - an open redirect reachable from any unvalidated `?next=` parameter. Both forms are now refused: `redirect()` throws as it already did for `//host`, and an auth guard falls back to its configured destination instead of honouring the value.

New export `isSameOriginPath` from `@nifrajs/core/server`, which is the single implementation the three gates now share - a security predicate kept in three copies is three chances for one of them to be hardened alone. It answers about a path, so an absolute URL is false even when it names the current origin: the point of the gate is that the value never got to name a host at all.

A percent-encoded backslash (`/%5Cevil.example`) is still a same-origin path, because that is what it resolves to.
