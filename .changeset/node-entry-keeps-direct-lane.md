---
"@nifrajs/core": minor
"@nifrajs/node": minor
"@nifrajs/web": patch
---

The server entry `buildTarget` generates for `node` now passes the app itself to `@nifrajs/node`'s `serve` and serves files with the adapter's own reader. The entry needs the `@nifrajs/node` of the same release, so a `node` build with an older one installed stops before bundling, names both versions and leaves the last deploy dir in place. A 5.3 adapter used to build cleanly and then throw when the server started. It used to wrap `app.fetch` in a plain `{ fetch }` handler. That wrapper hid the node-direct lane, so every page built an undici `Request` and drained a `Response`, and every file went through one too. The entry mounts `/assets` and, at the root, only the `public/` files the build copied, with the same type, cache, range, HEAD and hidden-file answers the Bun entry gives.

`serve`'s `static` option on `@nifrajs/node`:

- takes an array of mounts; a path goes to the first mount that takes it, by its prefix and, when set, its `files`.
- `files` lists the only URL paths a mount serves; any other path passes to the next mount, then the app, without that mount touching the disk.
- `cacheControl` sets `cache-control` for files not served immutable.
- types files from the same table as `servePublicDir`, so `.pdf`, `.mp4`, `.xml`, `.csv` and other common types are no longer sent as `application/octet-stream`; a link is typed by the file it resolves to.
- serves `/.well-known` by default, as `servePublicDir` does, and refuses a visible name that links to a dotfile.
- answers a link that leaves the directory with `404`, the same as a missing file, instead of `403`.
- sends files up to 256 KiB, and HEAD, `304` and `416` answers, in one write with no `Response` or stream.

`@nifrajs/core/static-file` exports `CONTENT_TYPES`, `contentTypeOf` and `isHiddenPath`, which both readers now use.
