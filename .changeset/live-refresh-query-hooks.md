---
"@nifrajs/web": minor
---

Query hooks can refetch on live keys. A query names the keys its data depends on with `{ live: [...] }` (plain and infinite queries); with `live({ queryKeys: true })` each live load carries a salted digest of every key it grants, the page matches its mounted queries' keys against them, and a change to one refetches the query, superseding a fetch in flight. A query that read before its key's watch began, or before it mounted, refetches once the watch is ready, so no change between the two is lost; a polled page refetches its live queries with each poll. In development each load is marked, so the page warns once about a query key no loader grants, or about `queryKeys` being off. `QueryClient` gains `clear()`, and a viewer switch on a live page now clears every query client the page made, mounted queries refetching for the new viewer.
