---
"@nifrajs/middleware": patch
---

`compression()` gzips a streamed response as one deflate segment per chunk, joined into a single gzip member, so each chunk still reaches the client as soon as it is written at less CPU than one gzip stream flushed per chunk. Each segment may refer back into the 2 KB before it, so small chunks after a large one compress as well as before. A chunk of up to 1 KB is deflated with fixed Huffman codes without zlib's per-call setup, unless those codes cannot halve it. Bytes a producer marks with `markRepeatedPrefix`, such as a partially prerendered page's shell, are compressed once, when a second response carries them, and reused for every later response whose chunk still holds them. Where `node:zlib` has no `crc32` (Node before 22.2), it keeps one gzip stream flushed per chunk.
