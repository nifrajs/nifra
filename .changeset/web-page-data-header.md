---
"@nifrajs/web": patch
---

A page request checks the client-navigation data header through the serving context's own header reader instead of `req.headers`, so a document request on Node no longer builds the request's full `Headers` object. The SSR benchmark apps serve 4-6% more pages per second on Node; Bun is unchanged.
