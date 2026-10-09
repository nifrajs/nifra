---
"@nifrajs/auth": patch
---

Session cookies are now signed together with their cookie name, so when two session managers share a secret, a cookie issued by one no longer verifies as the other's. Cookies signed by earlier versions still load and are re-signed on their next commit, so upgrading signs no one out.
