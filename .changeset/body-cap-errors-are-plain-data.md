---
"@nifrajs/core": patch
---

The body cap's 413/400 rejections are plain renders instead of `Response` objects.

`c.boundedBody()` and `c.boundedJson()` throw on an over-cap or malformed body, and the lifecycle catches that throw as control flow - the same contract as `throw redirect(...)`. What they threw was a built `Response`; it is now the same plain-data value `status(...)` produces, so a rejected request no longer pays for a `Response` on the way out. Identical on the wire: same status, same `{ ok: false, error }` body, same `content-type`.

The schema lane's own body read goes the same way, so a route with a `body` schema answers its 413/400 from plain data too.

The distinction is invisible to a handler that lets the throw propagate, which is the documented use. Code that catches it and inspects the value is affected: it is no longer a `Response`, so `.status` and `instanceof Response` are gone. Read `.plain` (`{ status, headers, body }`) or call `toResponse()`.

The urlencoded form reader takes the same lane, so a route whose schema parses a form answers its 413 and its 400 from plain data too, with the same envelope and the same bytes as the JSON reader's.

`jsonError` is unchanged and still exported - the surfaces that genuinely need a `Response` object keep it.
