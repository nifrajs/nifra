---
"@nifrajs/web": patch
---

Concurrent cache misses for one `withISR` page share a single render: the first renders and stores it, and the others are answered from that stored page. A render that is not stored, such as a `private` page or a failure, sends each waiting request to render for itself, so no request receives a page that was not safe to share. Requests with a cookie or `Authorization` header never join.
