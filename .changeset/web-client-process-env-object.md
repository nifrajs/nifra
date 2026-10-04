---
"@nifrajs/web": patch
---

In a client build, a bare `process.env` (one not followed by a baked `PUBLIC_*` name or `NODE_ENV`) is now an empty object. It was the string `"({})"`, so `"X" in process.env` threw a `TypeError` in the browser and `Object.keys(process.env)` listed characters. Reading any other variable still yields `undefined`.
