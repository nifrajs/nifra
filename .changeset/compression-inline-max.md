---
"@nifrajs/middleware": minor
---

`compression({ inlineMax })` gzips a buffered body of up to that many bytes on the calling thread. On Node the default hands every body to the thread pool, which costs throughput when each core already runs a process of its own: gzipping inline measured 1.5 to 4 times the pool's throughput at one CPU per process on Node 26. The default is unchanged.
