---
"@nifrajs/core": patch
"@nifrajs/auth": minor
---

A thrown `status(...)` now costs close to what a returned one costs, and the guards throw one.

`status(...)` is meant to be **returned** - from a `beforeHandle`, from a `derive`, from the handler. The one place a return cannot work is a helper called for effect: `requireSession(c)` decides the request is over from inside a call the handler makes, and only unwinding gets out of a half-finished handler. That is the whole remaining use of `throw`, and it now runs on the same lane as the return:

- The lifecycle error path is synchronous again. It was `async`, so a thrown `status(...)` - which needs no `await` at all - still allocated a promise and resumed a microtask later. The `onError` hook loop moved to its own async method, so only routes that registered a hook pay for one.
- The two remaining sites that turned a thrown `status(...)` into a `Response` before rendering it (the bare and contextless fast paths) now render it as the plain data it is, through the request's own finalizer.
- `requireSession` / `requireUser` / `requireAuthorization` throw a `status(...)` render instead of building a `Response`. The bytes on the wire are unchanged - a 401 JSON envelope, or a 302 with a `location` - and on Node they now carry a `content-length` instead of being drained back out as a stream.

**Behavior change:** what the guards throw is a `status(...)` render, not a `Response`. Code that catches a guard and tests `err instanceof Response` needs to stop doing that; nifra itself treats the two identically as control flow, so a guard thrown through a route behaves exactly as before.

Measured on the Linux rig (4 server cores, 50 connections, medians of 5 x 2s; a `derive` that rejects, returning vs throwing the same `status(401, ...)`). Only within-runtime deltas are readable - the host was under other load, and the return arm is included in both columns as the control:

| runtime | return | throw, before | throw, after |
| --- | --- | --- | --- |
| node | 85904 | 74471 | 80136 |
| deno | 139477 | 85970 | 90355 |

On Node a throw now lands within the run's own spread of a return. On Deno it does not: a throw still costs ~35%, and it costs the same whether the thrown value is a `status(...)` render or a `Response` - so what remains there is the unwind itself, not the rendering. That one is unexplained and is not claimed as fixed.
