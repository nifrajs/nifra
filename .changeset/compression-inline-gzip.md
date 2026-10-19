---
"@nifrajs/middleware": patch
---

`compression()` gzips a framework-serialized body by the fastest route each runtime has, measured over HTTP against the `CompressionStream` it used before. Bun gzips a body of up to 4 KiB inline and a larger one with a single `node:zlib` call (2 KB / 8 KB / 32 KB JSON: 1.14x / 1.40x / 2.10x). Deno gzips every body inline (2 KB / 8 KB / 32 KB: 1.38x / 1.72x / 1.89x). Node uses the single call up to 8 KiB (2 KB / 4 KB: 1.19x / 1.11x) and keeps the stream past that. A body that compresses far beyond typical JSON or HTML (over 100x) can serve slightly slower on Bun (0.93x).
