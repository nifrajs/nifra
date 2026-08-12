---
"@nifrajs/core": patch
---

Cut iterator overhead from the async lifecycle chain, the static-header pass, and cookie signing.

An array iterator declared inside an async function stays live across the `await` that follows it, so
neither JSC nor V8 sinks it: the `beforeHandle`/`onError` chains paid 43ns per hook on Bun and ~9ns
on Node for iteration alone. The static response-header pass paid it twice per header, once for the
list and once for the pair destructuring (211ns per response on a 5-header set), and signed cookies
paid it per digest byte (238ns per signature on Bun). All three now index directly.
