---
"@nifrajs/web": patch
---

`withISR` no longer serves a cached page to a soft-navigation data request. Cache entries are full
HTML documents keyed by URL, so a client-side navigation's loader fetch (`x-nifra-data`) could
receive a document where it expects a loader payload. Those GETs now bypass the cache entirely,
matching the write path, which already refused to store data-mode responses.
