---
"@nifrajs/graphql": minor
---

A new `maxFragmentExpansion` limit (default 20,000) bounds the selections that fragments, named and inline, bring into the selection sets holding them, summed over the document, and runs with the other limits before `validate()`. graphql-js validation walks that expanded form once per selection set, so a chain of fragments that each spread the next, or inline fragments nested inside one another, cost work quadratic in their count while depth and complexity stayed at one: a 64 KiB document held the event loop for hundreds of milliseconds per request, and `executionTimeoutMs` cannot interrupt validation. Such documents are now refused in under a millisecond. Set on `respondGraphql`, `graphqlWebSocket` or `mountGraphql`, which shares it with its subscriptions.
