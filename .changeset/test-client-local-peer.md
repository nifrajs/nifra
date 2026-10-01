---
"@nifrajs/client": minor
"create-nifra": patch
---

`testClient` calls now come from `127.0.0.1`, as a socket peer's would, so middleware keyed on the caller's address, such as `rateLimit()`, runs in tests as it does behind a listener. Pass `clientIp` to test another address. `inProcessClient` calls made outside a page render still carry no address.

The batteries template declares `@nifrajs/middleware`, and its tests pass on a fresh scaffold.
