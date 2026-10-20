---
"@nifrajs/islets": minor
---

Effects keep their subscriptions from one run to the next and only drop a signal a run stopped reading, and the flush queue is an array instead of a set. One signal driving many effects updates about twice as fast in Chrome and 4-12x faster in JavaScriptCore, with the same ordering, batching and teardown behaviour as before.

`data-bind-*` bindings subscribe once to the one signal they name instead of tracking reads, still queued, batched and run after computeds settle. A binding update costs about 10% less than an effect in Chrome and about half in JavaScriptCore, within 3-11% of a plain subscriber.

New `untrack(fn)` reads signals inside an effect or computed without subscribing to them.

`data-bind-value` also listens for `change`, so a `<select>` updates its signal even when the browser sends no `input` event first.

The full-feature island bundle budget is now 2,350 B gzipped, up from 2,080 B.
