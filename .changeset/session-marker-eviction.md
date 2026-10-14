---
"@nifrajs/auth": patch
---

`MemorySessionStore` keeps revocation markers apart from sessions, each bounded by `max`, so sessions written after a logout can no longer evict its marker. Once `max` newer sessions had been written, a request that loaded the session before the logout and committed after it brought the logged-out session back and re-issued its cookie. Markers also no longer take capacity from live sessions. The `SessionStore` contract now says a custom store must keep a marker until its `expiresAt`.
