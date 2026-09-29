---
"@nifrajs/middleware": patch
---

fix(middleware): a date-form `If-Range` in `rangeResponse()` keeps the range only when it equals the
representation's `Last-Modified` to the second, as RFC 9110 requires. Any other date, earlier or
later, gets the whole representation with 200.
