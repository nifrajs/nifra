---
"@nifrajs/core": patch
"@nifrajs/web": patch
---

Reduce web mount and SSR URL parsing overhead by reusing the core URL splitter, caching splits per
request, and using constant-time prerendered-path lookups in the client router.
