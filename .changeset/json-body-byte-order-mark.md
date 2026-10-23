---
"@nifrajs/core": patch
"@nifrajs/node": patch
---

A JSON body that starts with a UTF-8 byte order mark is read the way Fetch's `json()` reads it, with
the mark dropped, on every runtime. A body schema or `c.boundedJson()` on `@nifrajs/node` or on Deno
answered such a body 400 `invalid_json` where Bun and Workers parsed it.
