---
"@nifrajs/web": patch
---

A client navigation to a prerendered path that carries a query string now asks the server for its data, as a hard request for the same URL does, instead of reading the static `_data.json` rendered without that query. Filters and pagination driven by search parameters no longer show the default data after a soft navigation.
