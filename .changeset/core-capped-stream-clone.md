---
"@nifrajs/core": patch
---

A streamed request body that passes its byte cap fails with 413 at once, even when the app took a `clone()` it never reads. Before, the rejection waited until the clone was read or cancelled.
