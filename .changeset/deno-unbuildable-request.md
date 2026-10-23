---
"@nifrajs/core": patch
---

On Deno, a request the `Request` constructor will not rebuild - a `TRACE`, `CONNECT` or `TRACK`, or a
lower-case `get` with a body - is routed on its resolved target when that target holds a dot segment or
a backslash, and gets the 404 or 405 Bun and Node give. It was answered 500.
