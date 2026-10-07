---
"@nifrajs/web": patch
---

`withISR` removes a stored page when a background regeneration answers 401 or 403, or answers 2xx with `Cache-Control: private` or `no-store`. The stale public copy no longer keeps serving after the page is withdrawn. A regeneration triggered by a request carrying a cookie or `Authorization` header keeps the entry: that visitor's own refusal or private copy says nothing about the shared page. A 5xx or 429 still keeps serving the stale copy.
