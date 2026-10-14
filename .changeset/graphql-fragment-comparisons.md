---
"@nifrajs/graphql": minor
"@nifrajs/cli": patch
---

GraphQL documents whose fragments reach no field are refused before validation. Such a fragment reads zero on complexity, depth and field pairs, but graphql-js compares every pair of fragments a selection set spreads before it reports an unknown fragment or a cycle, so 64 KiB of `...A1 ...A2 ...` whose fragments each spread an unknown fragment, themselves or a shared cycle passed every limit and held the event loop for about 400 ms per request. A spread of an unknown fragment and a fragment cycle are now refused with graphql-js's message (without `locations`) before `validate()`, which answers that document in about 12 ms, parsing included. A new `maxFragmentComparisons` limit (default 100,000) counts the fragment comparisons validation would make, stopping once past the limit, so many valid fragments that each select a distinct field are bounded as well: 1,000 such spreads validated in 70 ms and 2,000 in 400 ms, and are now refused. The default admits a binary tree of 255 fragments. Set it on `respondGraphql`, `graphqlWebSocket` or `mountGraphql`, which shares it with its subscriptions.
