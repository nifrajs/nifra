---
"@nifrajs/cli": minor
---

`nifra check` reports an `<a href="/path">` written as a string, using the app's routes to tell two cases apart. NF-C057 (warn) is a path that no page, no backend route and no file in `public/` serves, so the link is a 404; the message names the nearest page when it is a typo away. NF-C058 (info) is a path that is a page today; the message gives the `href()` call that replaces it. A template literal is judged by its shape and never reported as dead. `.tsx`, `.vue` and `.svelte` files are read; a project with no `routes/` directory, or a backend route path the scan cannot read, gets no dead-link verdict.

Neither code fails a check by default (a warning fails only under `--strict`). Raise, lower or silence either with `rules` in `nifra.config`; keep one link as written with `rawHref(path)` or `// nifra-expect NF-C058: <reason>` above the attribute.
