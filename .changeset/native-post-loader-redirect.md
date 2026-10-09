---
"@nifrajs/web": patch
---

After a native form POST runs a page's action, a loader that returns `redirect()` or a status such as `notFound()` now answers the request with that redirect or status page, as the page's GET does. Before, the returned value was rendered as the page's data with status 200.
