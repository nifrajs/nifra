---
"@nifrajs/node": minor
---

feat(node): conditional and range requests for static files

`serve({ static })` sends a strong `ETag`, `Last-Modified`, and `Accept-Ranges: bytes`. It answers
`If-None-Match` and `If-Modified-Since` with 304, and a single `Range` on GET with 206, or with 416
and `Content-Range: bytes */size` when unsatisfiable. `If-Range` keeps the range only when it matches
the current validator: the exact `ETag`, or the `Last-Modified` date to the second. An `ETag` or
`Last-Modified` supplied through `headers`, in any case, is the validator these requests compare
against. A 304 carries no `Content-Length` or `Content-Type`. Multi-range and malformed ranges get
the whole file.

fix(node): a request hook that reads the body through `req.clone()` leaves it readable for the route
handler and schema validation.
