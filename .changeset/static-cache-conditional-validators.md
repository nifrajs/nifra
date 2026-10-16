---
"@nifrajs/node": patch
"@nifrajs/web": patch
---

Static files on Bun and Deno evaluate `If-None-Match` before `If-Modified-Since`, including the wildcard condition for an existing file. A stale entity tag can no longer produce a `304` from its accompanying date.
