---
"@nifrajs/web-preact": patch
"@nifrajs/web": patch
---

A Preact page that suspends without `defer()` (a `preact/compat` `<Suspense>` around a thrown promise, or `lazy`) is streamed and resolves on the server; it was a 500. A page whose string render suspended skips the string pass for its next 32 requests and goes straight to the stream, so a React page that suspends on `use` renders once per request rather than twice.
