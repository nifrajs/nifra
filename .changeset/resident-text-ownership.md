---
"@nifrajs/core": patch
---

A `c.text()` response adopted by body hooks remains single-use even when a hook substitutes its body without consuming the original stream. Returning that response again now answers 500 without its earlier request's cookies, on Web and Node-direct rendering alike; compression could previously replay a user's session cookie and send plain bytes with a stale gzip header.
