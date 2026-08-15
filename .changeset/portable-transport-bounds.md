---
"@nifrajs/proxy": minor
---

The portable transport is exported as `fetchTransport()`, and it now bounds a stalled response body the way the undici one does.

`timeoutMs` covers the wait for response headers - the only window in which a 504 is still sendable - and the undici transport has always taken a `bodyTimeoutMs` for what happens after. The `fetch()` transport had no such bound, so an upstream that sent its headers and then went silent held the relay open for as long as it liked, one request and one upstream connection per stalled body. It now errors the relayed stream and cancels the upstream read after the same 30s of silence between chunks, so the choice of transport no longer changes the bound:

```ts
import { createProxy, fetchTransport } from "@nifrajs/proxy"

const proxy = createProxy({
  upstream: "http://127.0.0.1:8081",
  transport: fetchTransport({ bodyTimeoutMs: 5_000 }),
})
```

The timer is armed per read and disarmed as soon as a chunk arrives, so a slow-but-progressing body is never interrupted; `0` disables it, and a negative or non-finite value throws at construction. The default transport is unchanged in behaviour beyond the new bound, and picking it explicitly costs nothing - `createProxy` without a `transport` still builds one instance, not one per request.

An `AbortSignal` passed in by the caller no longer accumulates a listener per proxied request. `createProxy` subscribes to it to tear the upstream hop down on a client disconnect, and for the common case - the request's own signal - that subscription dies with the request. A signal shared across many requests, such as a server-lifetime shutdown signal, kept every one of those listeners for as long as it lived. The subscription is now released when the response settles: on the error path, on a body-less response, and when the relayed body ends, errors, or is cancelled. A body relayed to a Node adapter still hands over its underlying stream, so the fast path is unaffected.
