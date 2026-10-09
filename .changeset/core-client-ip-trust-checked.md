---
"@nifrajs/core": patch
---

`server({ clientIp: { trustedHops } })` refuses a hop count that could never resolve a caller. A negative, fractional or non-number `trustedHops`, or a declaration with neither `trustedHops` nor `header`, used to be accepted, and `c.clientIp` was then `undefined` on every request. It now throws when the server is created.
