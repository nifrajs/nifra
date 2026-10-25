---
"@nifrajs/web": patch
---

Query clients and router fetchers hold nothing for the next visitor. `identityChanged()` clears every query client the page made, cached, infinite and hydrated queries alike, and returns every fetcher to idle. In an app with a `keepAlive` route, a new identity epoch cookie does the same on the next read, through the client or through a query handle or fetcher the page kept from before: data goes at once, and mounted queries and fetchers hear of it once the current render is over. A fetch or fetcher load in flight across the change is not kept. The epoch is read once per synchronous run, since a `document.cookie` read costs microseconds.
