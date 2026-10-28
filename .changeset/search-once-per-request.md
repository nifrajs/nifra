---
"@nifrajs/web": patch
---

A page request parses its query string and runs each route and layout `searchSchema` once, however many places read the search (the loader context, the effective search, the render props). Before, a page with a query string parsed it three times per document request. The values are unchanged; nested values inside them are now shared between those readers within a request.
