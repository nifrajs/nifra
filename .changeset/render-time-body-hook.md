---
"@nifrajs/core": minor
"@nifrajs/middleware": patch
---

A response-observer bundle can now offer `renderBody`, a synchronous fast path for its `onResponseBody` hook. When a handler returns a value, the framework runs it on the serialized JSON before any `Response` exists and builds one `Response` from the result, where the body tier built the rendered response and then a replacement for it. It applies only while the hook is the first response hook of the app (or of its group, under the group's prefix), and not on a reply carrying `c.set` headers or cookies, or on an app with static response headers; those keep the body hook. The body hook still runs on the rendered response and must find nothing left to do. `compression()` uses it: a returned value that gzips inline is answered as one `Response`. `c.json()` keeps its own reply, as a handler can read it back.
