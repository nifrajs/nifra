---
"@nifrajs/web": patch
---

`withISR` and `withCdn` treat a request an authentication stage accepted like one carrying a cookie or `Authorization`, whichever header held the credential: its page is stored, or marked storable for the CDN, only when the response is explicitly `public`.
