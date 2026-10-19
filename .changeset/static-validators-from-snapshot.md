---
"@nifrajs/core": patch
"@nifrajs/node": patch
"@nifrajs/web": patch
---

A static file's strong `ETag` now always names the bytes sent with it. `servePublicDir()`, `@nifrajs/node`'s `static` option and the generated Deno entry tag a file of up to 256 KiB from the same whole read they serve it from, so an in-place write during the request can no longer pair new bytes with the old tag. A larger file streams without an automatic `ETag`, as a write could reach it after any separate hash pass. Once its last change is more than 2 seconds old it carries `Last-Modified` for `If-Modified-Since` revalidation, but no `If-Range` resumes it: a guarded `Range` request gets the whole file, and an unguarded one still gets its range. A remembered tag is reused without hashing a snapshot over 24 KiB when a second `stat` after the read shows the file unchanged. `contentTags().ofFile()`, which tags a file over `CONTENT_TAG_MAX` by its identity, now mixes a random per-instance salt into that tag, so two servers no longer issue one tag for different files that share an inode, size and times. `@nifrajs/core/static-file` adds `CONTENT_SNAPSHOT_MAX`, `ContentTags.ofSnapshot()` and `streamedLastModifiedOf()`.
