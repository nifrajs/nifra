---
"@nifrajs/web": patch
---

A loader, action or boundary loader that throws a 2xx `Response` is refused exactly as returning one is: its body would reach the browser without passing the output schema. A thrown redirect or error status still answers the request.
