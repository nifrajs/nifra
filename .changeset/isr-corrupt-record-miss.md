---
"@nifrajs/web": patch
---

A stored ISR record that a `Response` could not replay, such as one with status 999, a non-finite timestamp or an illegal header, now reads as a cache miss and the page renders. Before, it passed the shape check and every request for that page threw.
