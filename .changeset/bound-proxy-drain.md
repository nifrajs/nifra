---
"@nifrajs/proxy": patch
---

The post-cancel request-body drain is now capped at 8 MiB. Once an early response (such as a `413`) has left, an over-cap trickle is discarded at the ceiling rather than holding the connection open.
