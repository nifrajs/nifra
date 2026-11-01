---
"@nifrajs/core": minor
"@nifrajs/auth": patch
"@nifrajs/authjs": patch
"@nifrajs/better-auth": patch
---

The three auth packages' guards deny a missing session through one owner: `@nifrajs/core/guard-deny` now holds `UnauthenticatedResponse`, the default `401` it builds (`unauthenticatedResult`), and the fail-loud check `assertUnauthenticated`, which refuses a denial that both redirects and answers, and a status outside 400-599. A new argument carries the package name, so every error keeps its prefix (`[nifra/auth]`, `[nifra/authjs]`, `[nifra/better-auth]`). Each package re-exports `UnauthenticatedResponse` and keeps its own guard options and its redirect rejection; no behavior and no message changed. The new subpath imports only the status lane, so it costs nothing beyond the grammar itself.
