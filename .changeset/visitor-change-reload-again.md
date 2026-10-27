---
"@nifrajs/web": patch
---

A reload for a visitor change loads once more when the identity epoch moves while it runs, so the router and the query client see another tab's sign-in or sign-out that lands during the reload. A fetcher's submit keeps its answer, and its pending state, when the visitor changes while its POST is in flight.
