---
"@nifrajs/core": minor
"@nifrajs/middleware": patch
---

A response-observer bundle can now offer `renderBody`, a synchronous fast path for its `onResponseBody` hook. When a handler returns a value, the framework runs it on the serialized JSON before any `Response` exists and builds one `Response` from the result, where the body tier built the rendered response and then a replacement for it. It applies only while the hook is the first response hook of the app (or of its group, under the group's prefix), and not on a reply carrying `c.set` headers or cookies, on an app with static response headers, or on an app with the idempotency plugin, whose stored reply must stay the identity one; those keep the body hook. The body hook is not run again over a response it rendered with new bytes, so it must be idempotent on its own output wherever else it sees one. `compression()` uses it: a returned value that gzips inline is answered as one `Response`. `c.json()` keeps its own reply, as a handler can read it back.
