---
"@nifrajs/core": patch
---

A body that a `derive` or `beforeHandle` hook reads through `c.req` stays readable for the framework readers that come after it. An auth-first route's body schema (`validationOrder: "auth-before-validation"`) and `c.boundedBody()` / `c.boundedJson()` now parse the bytes the hook read, for framed and chunked bodies on every adapter, where they answered 500.
