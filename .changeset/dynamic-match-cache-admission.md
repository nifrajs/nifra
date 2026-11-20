---
"@nifrajs/core": patch
---

The router admits a dynamic path to its match cache after it is seen twice within a bounded window, so hot paths that arrive interleaved are cached too.
