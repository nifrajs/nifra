---
"@nifrajs/cli": patch
---

`nifra dev` inlines the public environment (`PUBLIC_*`, or the configured `publicEnvPrefix`) into the client bundle on the default Bun pipeline, as `nifra build` already does. Before, a `process.env.PUBLIC_X` read in the browser stayed a runtime read and was always undefined there, so a value set for the dev server never reached the page.
