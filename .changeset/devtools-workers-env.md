---
"@nifrajs/devtools": patch
---

fix(devtools): construct on runtimes without `process`

`devtools()` reads `NODE_ENV` through `globalThis.process`, so it constructs (disabled by default) on
Cloudflare Workers without `nodejs_compat`.
