---
"@nifrajs/core": patch
"@nifrajs/node": patch
---

fix(core): a `Response` thrown after `c.set.cookie(...)` or `c.set.deleteCookie(...)` ships those
cookies, as the same `Response` returned does. A login handler or a guard that sets or clears a
session and then throws a redirect now sends the `Set-Cookie` on every runtime and lane, whether the
throw comes from the handler, `derive`, or `beforeHandle`. `c.set.headers` and `c.set.status` still
do not apply to a `Response`, thrown or returned, and a thrown `Response` still skips `onError`.

fix(core): queued cookies reach a `Response` whose headers are immutable, such as
`Response.redirect(...)` or a `fetch()` result on Node, Deno, and Workers, whether it is returned or
thrown.
