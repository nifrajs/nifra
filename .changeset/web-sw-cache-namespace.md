---
"@nifrajs/web": patch
---

The generated service worker names its cache `<cacheName>:<buildId>` and, on activation, deletes only older caches in that namespace. Caches another app or the page itself created on the same origin are left in place. A cache an earlier worker named `<cacheName>-<buildId>` is outside the namespace and is not deleted.
