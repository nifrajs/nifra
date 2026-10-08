---
"@nifrajs/core": minor
"@nifrajs/edge": patch
"@nifrajs/node": patch
"@nifrajs/middleware": patch
"@nifrajs/web": patch
---

A Response returned to more than one request no longer carries one request's headers to another. A Response without a body (a module-level `new Response(null, { status: 204 })`, a kept redirect) can be sent any number of times, so the cookies a handler queues with `c.set.cookie`, the app's `responseHeaders`, and the headers written by `onResponse` hooks, response observers and response middleware go on a copy made for the request; the Response the handler returned stays as it was built. A Response with a body can be sent once: returning it again answers `500` with `{"ok":false,"error":"internal_error"}` and none of the headers written for the earlier request. On `@nifrajs/node`, a response whose body cannot be written is answered with a `500` that carries none of the headers set for it.

`writableResponse(response, request?)`, exported from `@nifrajs/core/server`, returns the Response a request may write headers on: the response itself when it has a body and writable headers, otherwise a copy. Pass the request and a copy already made for it is reused by its later writers.

`renderResult(result)`, exported from `@nifrajs/core/edge-kit`, renders a framework `ResponseResult` exactly as `toResponse` does without taking a handler's `Response`. `@nifrajs/edge` renders its rejections with it; responses are unchanged and the bundle is smaller.
