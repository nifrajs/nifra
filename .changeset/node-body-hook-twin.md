---
"@nifrajs/core": patch
---

perf(core): add opt-in Node-direct twin for `onResponseBody` hooks

`onResponseBody(fn)` took the portable hook everywhere: on the Node-direct lane it
ran through the shared native wrapper, allocating a header view per request even for
twins that only read the bytes and set a header. `onResponseBody(fn, node)` accepts
an optional `NodeResponseBodyHook` twin receiving the same serialized bytes plus the
outcome record, returning through the same replacement channel (`undefined` keeps the
body; bytes or `{ body, status }` are applied by the shared `applyBodyReplacement`).
The null-body skip, async continuations, and throw propagation are unchanged - the
twin only skips the view allocation - and Bun/Deno keep the portable hook untouched.

A `Middleware` may declare the twin as `onNodeResponseBody` next to `onResponseBody`
(a lone twin throws at registration, mirroring `onNodeResponseHeaders`).
