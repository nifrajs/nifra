---
"@nifrajs/middleware": patch
---

`negotiateContentType()` and `parseAcceptHeader()` accept the `*/*` media range that browsers, `fetch` and `curl` send, so such a request no longer matches nothing. `*/*` still ranks below a named type or `type/*`, and an invalid `*/json` is ignored.
