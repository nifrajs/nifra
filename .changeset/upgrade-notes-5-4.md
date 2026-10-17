---
"@nifrajs/cli": patch
---

`nifra upgrade 5.4.0` prints what changes for a 5.3 app: a `node` build needs the adapter of the same release, static files carry content `ETag`s and drop `Last-Modified` for copied mtimes, the Deno entry answers validators, and `@nifrajs/node`'s `static` reader changes its types, ranges and link answers.
