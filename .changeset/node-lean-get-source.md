---
"@nifrajs/node": minor
---

perf(node): lean request source for GET/HEAD

GET/HEAD requests (the bulk of API traffic) now use a smaller request-source object in the Node
adapter: no body plumbing is allocated (GET/HEAD carry none, per the fetch spec — `body` is `null`,
`boundedBody()` resolves empty), while headers and the full Web `Request` stay lazily available if
read. Body-capable methods keep the existing lazy source. No behavior change.
