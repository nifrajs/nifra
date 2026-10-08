---
"@nifrajs/islets": minor
---

Unmounting an island through the disposer `mountIslands` returns now stops every `effect` and `computed` that island's setup and bindings created, so mounting and unmounting an island repeatedly leaves nothing subscribed to a longer-lived signal.
