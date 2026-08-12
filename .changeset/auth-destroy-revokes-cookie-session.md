---
"@nifrajs/auth": patch
---

`destroy(c)` called without a `Session` object now revokes the stored record addressed by the request's
signed session cookie, instead of only clearing the cookie. A logout handler that had not first loaded
the session cleared the browser's copy while the server-side record stayed valid for its full TTL, so a
copy of the cookie taken before logout still authenticated. The id comes from the signed cookie, so
only a session the caller actually presented can be deleted.
