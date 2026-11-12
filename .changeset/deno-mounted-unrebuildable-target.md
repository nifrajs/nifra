---
"@nifrajs/core": patch
---

On Deno with `normalizeTarget`, an app reached through `mount()` or `mountFetch()` routes a TRACE or TRACK request on the target its parent resolved. Before, it was handed the request with its dot segments as sent, so `TRACE /x/../pages/form` matched the mounted app's routes raw and got a 404, or a catch-all route's 405, where every other runtime answers the page's 405 with its `Allow`.
