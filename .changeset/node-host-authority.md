---
"@nifrajs/node": minor
---

Two new `serve()` options decide the authority in `request.url`. `allowedHosts` takes a list or a
predicate and answers `400` before the app runs when the inbound `Host` is not one of them;
`canonicalHost` builds every request URL from one fixed authority and ignores the inbound value, the
right setting behind a proxy that already validates. Both parse the header properly: the port is
range-checked, the bracketed IPv6 form is handled, and anything carrying CR/LF, whitespace, or
userinfo is rejected.

The check runs at request entry, so the lean GET path that builds its URL lazily is covered too.
With neither option set, behavior is unchanged and the host in `request.url` remains
client-controlled - the README now says so, along with the public-only contract for the `static`
root.
