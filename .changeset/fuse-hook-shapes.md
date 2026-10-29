---
"@nifrajs/core": patch
---

A route whose only lifecycle steps are derive, before and after hooks now runs them in one fused closure chain for any number and mix of them, instead of only for one derive and one before hook. Routes with just a before, derive or after hook, and routes with several of a kind, answer exactly as before and skip the general runner's per-request setup. The Web, Node and Bun lanes are covered, with or without a query or body schema.

A `status()` or `Response` thrown from a fused or bare route whose body cannot be written now ends the request as a 500 instead of rejecting it.
