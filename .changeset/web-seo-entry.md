---
"@nifrajs/web": minor
---

`@nifrajs/web/seo` exports `canonical()`, `openGraph()` and `jsonLd()` (and `OpenGraphInput`) from a module that imports nothing at runtime. A route's `meta()` runs in the browser too, and the package root also exports server modules that import `node:fs`, `node:path` and `node:stream`. A bundle that cannot prune the root's unused re-exports would carry those into a browser chunk, and `nifra dev` refuses them. The root keeps exporting the same three functions. The SEO guide imports them from the new entry.
