---
"@nifrajs/graphql": patch
---

Document limits measure each fragment once and reuse the result at every spread, so measuring a document takes time linear in its length however often it spreads its fragments.
