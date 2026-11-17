---
"@nifrajs/middleware": patch
---

`compression()` on Bun for Linux now gzips a buffered body up to 64 KiB inline instead of sending anything over 4 KiB to the thread pool. In Docker on four pinned CPUs a gzipped 8 KB JSON route served 1.2x as many requests from one process and 1.9x as many from four, and the gain held at 17, 33 and 67 KB. Bun on macOS keeps the 4 KiB cut, where the pool measured faster.
