---
"@nifrajs/auth": patch
---

A store-mode session cookie changes whenever the session's data does. It carries the session id with a tag that a commit renews only when the data changed, so a commit with the same data writes the same cookie and a sign-in, an account switch or `clear()` under a kept session id writes a new one. A response that changes who is signed in now shows it, and `@nifrajs/web` keep-alive drops the pages kept for the previous visitor even when the app does not regenerate the id. A cookie from an earlier version still loads and keeps its form until the data changes; a cookie with a tag reads as signed out on an earlier version.
