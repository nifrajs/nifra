---
"@nifrajs/web": major
"@nifrajs/node": patch
---

`redirect()` returns a plain render instead of a `Response`.

A redirect is a status line and one header - the most body-less response there is - and building a Web `Response` for it costs the whole object, plus a stream drained back out on Node. It is now the same plain-data value `status(...)` produces, rendered on the lane an ordinary return takes: same bytes on the wire, now with a `content-length` on Node rather than a chunked empty body.

`redirect(...)` is still returned or thrown from exactly the same places - loader, action, layout gate - and `return redirect()` / `throw redirect()` stay interchangeable, including the client-submit conversion to a 204 + `X-Nifra-Redirect`.

**Breaking:** the returned value is no longer a `Response`, so `.status`, `.headers`, and `instanceof Response` are gone from it.

- Reading it: `redirect("/x").plain` is `{ status, headers, body }`. `toResponse()` builds the `Response` if something genuinely needs one.
- Adding headers: pass them - `redirect("/x", { headers: { "cache-control": "no-store" } })`. Cookies are unaffected; they still ride `c.set` and apply to a redirect exactly as before.
- Testing it: assert on `.plain` (or `toResponse()`), not on `.status`.

The Node writer was framing a body-less response as chunked: `writeHead` followed by a bare `end()` leaves Node to pick the framing, so the shortest response the framework emits went out with a chunk terminator and no length, where every Web-native runtime sends `content-length: 0`. It now declares the zero length on both lanes - a plain render, and a hand-rolled `Response` whose body is `null`. Excluded: HEAD, whose length describes the GET's body that neither lane knows; a status that cannot carry a body; and a length the caller set for itself. A `Response` with a real body still streams, its length unknowable without buffering it.

A hand-rolled `Response` from a loader or action is untouched - still passed through verbatim, still converted the same way on a data request. Only what `redirect()` itself returns changed.
