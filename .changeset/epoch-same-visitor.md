---
"@nifrajs/web": patch
---

The identity epoch stays put while the same visitor's session renews. An `@nifrajs/auth` cookie-mode session re-signed with the same data, as a rolling session is on every commit, renews the epoch it holds with the new lifetime instead of rotating it, so kept pages survive and the page on screen does not reload on each response. A sign-in, a sign-out or a change to the session's data still rotates it.
