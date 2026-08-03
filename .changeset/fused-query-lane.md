---
"@nifrajs/core": patch
---

Query-validated routes now take the fused Web lane. A route whose only lifecycle step is a query schema (no body/params schema, no hooks, no idempotency/ledger, no validation-error recovery) compiles parse + validate + handler + respond into one closure: with a sync validator and handler there is no lifecycle promise at all. Semantics are unchanged - the 422 contract, thrown-Response control flow, repeated-key promotion, async validators, `c.set`, decorations, and `merge()` all behave exactly as the generic lane, and any recovery hook or wrapper keeps the route on that lane. This is the biggest win for validated GET endpoints on V8 runtimes (Node, Deno), and it speeds up Bun too.
