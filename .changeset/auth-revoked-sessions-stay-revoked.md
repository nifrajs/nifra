---
"@nifrajs/auth": patch
---

A store-mode session ended by `destroy` or rotated by `regenerate` stays ended. A request that loaded the session before the logout and committed after it (a rolling renewal, a slow handler) used to write the record back, so a copy of the cookie taken before logout worked again. Logout and rotation now also write a revocation marker under `<id>.revoked`, every load checks it, and a commit of a revoked session removes its write and sets no cookie, so it cannot replace a session the browser obtained since. A custom `SessionStore` must accept that key like any other; loading a store-mode session reads two keys in parallel.
