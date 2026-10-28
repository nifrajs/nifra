---
"@nifrajs/web": patch
---

A page request parses its query string once, however many places read the search (the loader context, the effective search, the render props). Before, a page with a query string parsed it three times per document request. Each reader still validates and receives its own copy, so the values and their independence from one another are unchanged.
