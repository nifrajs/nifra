---
"@nifrajs/web": patch
---

A layout loader that returns `redirect()` or a `Response` now refuses the request, the same way a thrown one does. A returned one used to be sent as layout data, next to the page loader's data, with a 200.

In development, nifra warns the first time a layout loader without `gate = true` refuses a request with a redirect, a `Response`, or a 401 or 403. Such a loader is not an authorization boundary: a client navigation can skip it, and an action below it runs without it. Refuse access in middleware, or export `gate = true`.
