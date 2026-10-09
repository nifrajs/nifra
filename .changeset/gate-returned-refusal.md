---
"@nifrajs/web": patch
---

A `gate` layout loader that returns a `redirect()`, a status such as `notFound()`, or a `Response` refuses the request exactly as one that throws it: the page loader and the action do not run, on document, data and form requests alike.
