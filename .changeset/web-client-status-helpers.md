---
"@nifrajs/web": patch
---

`notFound`, `gone` and `statusPage` are also exported from `@nifrajs/web/client`. A route helper that
the browser loads too can import them there, so Vite's dev server no longer sends it the root entry
and its `node:crypto` import.
