---
"@nifrajs/core": minor
"@nifrajs/node": patch
"@nifrajs/web": patch
---

The server entry `buildTarget` generates for `deno` now answers static files with the validators the Bun and Node entries send:

- `last-modified` from the file's modification time.
- `304` with no body for an `If-Modified-Since` at or after that time, HEAD included.
- `Range` honored only when `If-Range` is absent or names that exact date; an older or later date, or an entity tag, gets the whole file.
- a link is typed by the file it resolves to, as on Bun and Node.

`@nifrajs/core/static-file` exports `isNotModifiedSince` and `ifRangeAllowsPartial`, the date comparisons `servePublicDir`, the Deno entry and `@nifrajs/node`'s `static` reader now share.
