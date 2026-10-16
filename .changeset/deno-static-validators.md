---
"@nifrajs/core": minor
"@nifrajs/node": patch
"@nifrajs/web": patch
---

The server entry `buildTarget` generates for `deno` now answers static files with the validators the Bun and Node entries send:

- an `etag` and `last-modified`, and a `304` with no body for a current copy, HEAD included.
- `Range` honored only when `If-Range` is absent or names the file's current validator; anything else gets the whole file.
- a link is typed by the file it resolves to, as on Bun and Node.

`@nifrajs/core/static-file` holds the comparisons `servePublicDir`, the Deno entry and `@nifrajs/node`'s `static` reader now share.
