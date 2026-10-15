---
"@nifrajs/web-solid": patch
---

Solid server renders no longer read `process.env.NODE_ENV` on every render. The check that keeps a caught server error's text out of the hydration script now runs only when an error is serialized, with the same outcome: outside development and test, including an unset `NODE_ENV`, the browser receives "Internal Server Error". On Node, where each `process.env` read is a native call, the SSR benchmark's catalog page renders about 1.5% faster.
