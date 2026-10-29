---
"@nifrajs/core": patch
---

A route with derive, before or after hooks keeps its fused closure chain when the app also registers an error hook or decorates its context, instead of falling back to the general runner. Error hooks see the same errors in the same order, a decoration is on the context before the first hook runs, and a thrown `status()` or `Response` whose body cannot be written reaches the error hooks as a fault.
