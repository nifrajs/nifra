---
"@nifrajs/web": patch
"@nifrajs/web-vue": patch
---

The development-only keep-alive checks run in a Vite dev browser: `window.__nifraKeepAlive` for the
devtools kept-pages list, the kept views it counts, and the `NIFRA_KEEPALIVE_DIRECT_CHILD_CSS` report.
They read `process.env.NODE_ENV`, which every bundler replaces, without first asking for a `process`
global the browser does not have.
