---
"@nifrajs/testing": minor
---

feat(testing): add `@nifrajs/testing` — cookie-aware in-process test sessions

`@nifrajs/client`'s `testClient` already drives an app's `fetch` with end-to-end types (no server, port,
or network). This adds what it doesn't: a `cookieJar()` and a cookie-persisting `testSession(app)`, so a
login → authenticated-request flow tests as easily as a single request — `Set-Cookie` is captured and the
`Cookie` header is sent automatically across calls (honouring `Max-Age=0` / past `Expires` for logout).
Same typed in-process client; the only addition is a shared cookie jar.
