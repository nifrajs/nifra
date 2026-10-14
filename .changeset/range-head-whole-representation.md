---
"@nifrajs/middleware": patch
"@nifrajs/web": patch
---

`rangeResponse()` and `servePublicDir` ignore a `Range` header on a HEAD request, as RFC 9110 section 14.2 defines range handling for GET only: HEAD answers 200 with the full `content-length` and no `content-range`, the same as the Node static bridge. Before, HEAD with `Range` answered 206 or 416 with the metadata of the requested slice.
