---
"@nifrajs/events": patch
---

`parse()` keeps its promise never to throw when an envelope's `type` or `version` is a value JSON cannot hold, such as a bigint or a cyclic object: it now reports the issue. Issue messages also quote at most 64 characters of a received string.
