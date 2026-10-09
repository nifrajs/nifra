---
"@nifrajs/core": patch
---

A route written with non-ASCII text or a space (`.get("/café")`, `.get("/a b")`) now matches: its literal text is registered as a request spells it, composed to NFC and percent-encoded. Such a route used to answer 404 for every request.
