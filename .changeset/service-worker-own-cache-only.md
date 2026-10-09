---
"@nifrajs/web": patch
---

The worker from `generateServiceWorker` answers only the build's own precached URLs, and reads them, and the offline page, only from the build's own cache. Before, every same-origin GET, an API call included, was looked up with `caches.match` across all of the origin's caches, so a response a page or another app had stored with the Cache API could be served in place of the network.
