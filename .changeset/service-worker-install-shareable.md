---
"@nifrajs/web": patch
---

The generated service worker checks each precache response before it stores any: an error status, a redirect, or `Cache-Control: private` or `no-store` fails the install, and the build's cache stays empty. It used to store whatever `cache.addAll()` fetched, so an `offlineUrl` rendered for one signed-in visitor could be served to every later visitor in that browser profile. A runtime cache miss now also skips a `private` response, as it already skipped `no-store`.
