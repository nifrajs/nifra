---
"@nifrajs/core": patch
---

An idempotent route's response refused by its `content-length` alone now has its body cancelled. The lane replaces it with a 507 and never reads it, so a streaming handler or a proxied upstream stayed open; a response refused while it streams was already cancelled.
