---
"@nifrajs/testing": patch
---

`cookieJar` removes a cookie for any `Max-Age` of zero or less (`Max-Age=-1`, `Max-Age=00`), and lets `Max-Age` outrank `Expires`, as browsers do. Only an exact `Max-Age=0` counted before, so a test could pass with a cookie a browser would already have dropped.
