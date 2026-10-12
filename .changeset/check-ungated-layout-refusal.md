---
"@nifrajs/cli": patch
---

`nifra check` reports NF-C042, a warning, for a layout loader that refuses access in its own body (`redirect()`, `statusPage(401)` or `statusPage(403)`, or `new Response(...)`) when the layout does not export `gate = true` and has no `middleware`. A client navigation that keeps the layout skips that loader, and an action below it runs without it, so the check does not protect the pages under it. A refusal inside a helper the loader calls is not seen; the development warning in `@nifrajs/web` catches that case when it runs.
