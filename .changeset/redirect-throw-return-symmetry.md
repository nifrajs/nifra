---
"@nifrajs/web": patch
---

`redirect()` (and any `Response` control-flow signal) now behaves identically whether a loader or action returns it or throws it. A loader that RETURNS `redirect(...)` passes the response through to the client verbatim instead of serializing the `Response` object as loader data; a returned status signal renders its boundary exactly like a thrown one. An action (or a layout gate on the mutation path) that THROWS `redirect(...)` gets the same treatment as a returned one: a client submit receives the `X-Nifra-Redirect` header on a 204 and navigates, a native form POST receives the 3xx.
