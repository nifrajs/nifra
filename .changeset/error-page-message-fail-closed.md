---
"@nifrajs/web": patch
---

A server-rendered `_error` page shows the thrown error's own message only when `NODE_ENV` is `development` or `test`. With `NODE_ENV` unset, as in an unbuilt `bun app.ts`, it now gets the generic `Internal Server Error` that production already got, instead of the raw message.
