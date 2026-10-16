---
"@nifrajs/web": patch
---

On Bun, `servePublicDir` now sends `content-length` for files up to 1 MiB, whole or ranged. This covers the Bun server entry and `nifra dev`. `Bun.serve` drops the declared length of a stream body and sends it chunked, so these files used to arrive with no length: no download progress, and caches and proxies could not size them. They are now read whole through the already-open file, as files up to 256 KiB already were, which serves a 1 MiB file about a third faster. Files above 1 MiB still stream, and Bun still sends them chunked. Node and Deno keep a stream's length and are unchanged.
