---
"@nifrajs/node": patch
---

A Host carrying an IPv6 literal that no URL parser takes, such as `[1:2]`, answers 400 instead of
reaching the app, where `new URL(c.req.url)` threw.
