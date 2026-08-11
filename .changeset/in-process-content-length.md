---
"@nifrajs/client": patch
---

`inProcessClient` now stamps `content-length` on the synthetic requests it builds whenever the body's byte size is knowable (string, `URLSearchParams`, `Blob`, `ArrayBuffer`, typed-array bodies). The `Request` constructor never derives the header, so an in-process POST used to arrive lengthless - which a fail-closed Content-Length gate such as `bodyLimit()` correctly refuses with 411 even though the same call over a socket would carry the header and pass. In-process requests now look exactly like their network twins; stream and `FormData` bodies stay lengthless, matching chunked transfer.
