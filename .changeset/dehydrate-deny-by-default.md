---
"@nifrajs/web": minor
---

`dehydrate` now sends nothing unless `shouldDehydrateQuery` selects the queries to include. Every dehydrated value is serialized into the page and readable by the visitor, so a bare `dehydrate()` no longer sends every successful query. To keep the previous behavior, pass `shouldDehydrateQuery: () => true`.
