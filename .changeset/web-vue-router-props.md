---
"@nifrajs/web-vue": patch
---

A page receives `path`, `search` and `params` as props only when it declares them. Undeclared, they landed on the page's root element as attributes, and an object value rendered on the client but not on the server, so hydration reported a mismatch.
