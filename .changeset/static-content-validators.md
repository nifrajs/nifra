---
"@nifrajs/core": minor
"@nifrajs/node": patch
"@nifrajs/web": patch
---

Static files are tagged by their content on every self-hosting entry: `servePublicDir` (the Bun entry and `nifra dev`), `@nifrajs/node`'s `static` reader and the generated Deno entry. Each sends a strong `ETag` of 128 bits of the file's SHA-256, the same for the same bytes on every instance and runtime. A replacement that keeps a file's size and modification time (`cp -p`, `rsync -a`, tar, a container image layer, SOURCE_DATE_EPOCH, the Nix store's 1 s) is no longer answered with a `304` for the old copy, and a resumed download is no longer spliced from two versions. The Node reader's `"<mtime>-<size>"` tag is gone; the Bun and Deno entries send a tag for the first time.

- A tag is remembered per process for the file version it was read from (device, inode, size, mtime and ctime), so a known file costs no extra read. The first request for a file reads it once, and a file within the buffered size is then served from those bytes. Concurrent first requests share one read. A file changed in the last 2 s is read again until its ctime settles. A file over 256 MiB (`CONTENT_TAG_MAX`) is tagged by that identity instead: still strong, but different on each instance.
- `Last-Modified` is sent only while the file's mtime is the time of its own last change (within 1 s of its ctime). A file whose mtime a copy or build set, such as every file in a container image, is sent without it, so `If-Modified-Since` cannot validate it.
- An `If-Range` date no longer keeps a range for a file with a strong tag; a client resumes by the tag. On Node a configured strong `ETag` likewise sends the whole file for a date, while a configured weak one still lets a configured `Last-Modified` resume by its exact date.
- `@nifrajs/core/static-file` exports `contentTags`, `CONTENT_TAG_MAX`, `lastModifiedOf` and `isNotModified`, the `If-None-Match` and `If-Modified-Since` check all three readers share. `ifRangeAllowsPartial` now takes the file's tag.
