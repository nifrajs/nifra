---
"@nifrajs/client": patch
---

A path param holding an unpaired UTF-16 surrogate, which has no URL spelling, now resolves to the `invalid_path` failure Result without sending anything. Before, building the call threw a `URIError`.
