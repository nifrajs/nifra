---
"@nifrajs/middleware": patch
---

On Bun, `compression()` gzips a streamed response as one deflate segment per chunk, joined into a single gzip member, so each chunk still reaches the client as soon as it is written at less CPU than one gzip stream flushed per chunk. Each segment may refer back into the 2 KB before it, so small chunks after a large one compress as well as before. Bytes a producer marks with `markRepeatedPrefix`, such as a partially prerendered page's shell, are compressed once, when a second response carries them, and reused for every later response whose chunk still holds them. Node and Deno keep their native gzip stream, which measured faster there.
