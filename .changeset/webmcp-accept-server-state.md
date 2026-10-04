---
"@nifrajs/webmcp": minor
---

`executePredicted()` applies the capability's `reconciliation` policy. Under `"accept-server-state"`, a successful call whose prediction conflicted with a newer commit still commits the server's state, so concurrent calls end on the latest server response. `PredictionStore.commit()` takes the policy as a new optional fourth argument, `{ reconciliation }`. `"manual"` and `"reload"` keep reporting `conflicted` and leave the base unchanged.
