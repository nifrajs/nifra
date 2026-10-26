---
"@nifrajs/auth": minor
"@nifrajs/web": patch
---

`createSessions({ identity })` names the data keys that say who the visitor is, such as a user id, an organization or a role. The session cookie's tag then changes only when one of them does, in either mode, so `@nifrajs/web` keep-alive keeps the pages it holds across a commit that writes other data, a cart say. Unset, every key counts. Once `identity` is set, a cookie-mode cookie carries the tag in its signed payload, and an earlier version still reads it.
