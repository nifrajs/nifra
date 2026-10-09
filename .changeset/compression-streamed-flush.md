---
"@nifrajs/middleware": patch
---

`compression()` now flushes each chunk of a streamed body as it is compressed on runtimes with `node:zlib` (Bun, Node, Deno), so a streamed page shell reaches the client before the rest of the page instead of after the whole stream closes. Runtimes without `node:zlib` keep using `CompressionStream`.
