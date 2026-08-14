---
"@nifrajs/core": minor
"@nifrajs/node": patch
---

New `status(code, body?, init?)`: end a request from anywhere in the lifecycle without building a `Response`. Every error the framework renders itself now takes the same lane.

```ts
import { server, status } from "@nifrajs/core"

app.derive((c) => {
  const user = sessionOf(c)
  if (user === undefined) return status(401, { ok: false, error: "unauthorized" })
  return { user }
})
```

A `beforeHandle` could always short-circuit by returning a value, but a `derive`'s return **is** the context extension, so its only early exit was `throw new Response(...)` - the most expensive way to say 401. It is three costs stacked: constructing a Web `Response`, throwing it, and unwinding a lifecycle stage. On Node there is a fourth, because a `Response` built outside the handler is opaque to the adapter, so its body is drained back out through a Web stream and the reply goes out chunked instead of with a `content-length`.

`status(...)` is plain data - a status, optional headers, and a body the rendering lane serializes exactly like a handler's plain return - so a rejection now costs what an accepted request costs. It can be returned (preferred) or thrown, so a guard helper called for effect (`requireSession(c)`) can still end the request from inside a call it makes.

Measured on the Linux rig (4 server cores, 50 connections, medians; a rejecting `derive` vs the same `derive` returning `status(...)`, so both exit at the same point in the lifecycle):

| runtime | `throw new Response` | `status(...)` |
| --- | --- | --- |
| node | 39974 | 68577 |
| deno | 58403 | 89742 |
| bun | 79757 | 109328 |

The gap is largest on Node because of the drain, but the lifecycle cost was never runtime-specific: throwing to leave a `derive` cost every runtime real throughput.

The same render now serves the errors an application cannot move onto a faster lane itself - 404, 405, 400 on a malformed path, 415, 422 on a validation failure, 500, 504, and the admission rejections. Bytes are unchanged on every lane, and the Node lane gains a `content-length` it did not have. `Response` stays exactly what it was for everything that genuinely needs one: redirects, streams, and any handler that returns or throws one.
