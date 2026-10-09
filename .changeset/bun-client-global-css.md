---
"@nifrajs/web": patch
---

A Bun client build now links a stylesheet that the `clientModule` imports on every server-rendered page. When routes owned their own CSS, each page linked only its route's stylesheet, so global styles imported by the client module were missing until the client bundle loaded. Each page now links the client module's stylesheet first, then the route's.
