---
"@nifrajs/middleware": minor
---

`csrf()` lets a QUERY request through without a token by default, as it does a `GET`: a cross-site page cannot send one, since a form has no such method and a cross-origin `fetch` with it must pass a CORS preflight. List `"QUERY"` in `methods` to guard it anyway. `cors()` includes `QUERY` in the methods its preflight advertises by default.
