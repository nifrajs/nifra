---
"@nifrajs/middleware": patch
---

`cache()` no longer serves a stored entry to a credentialed request. The write side already refused to
store a personalized response, but a request carrying credentials could still be answered from an
entry stored earlier by an anonymous caller, before the route's own authentication ran. Reads now
apply the same test as writes: a request carrying a credential header only reads an entry whose own
`Cache-Control` marks it public (`public` or `s-maxage`). The credential headers are configurable via
`authenticatedHeaders` and now include `x-api-key` alongside Authorization and Cookie. Routes with
`cacheAuthenticated: true` are unaffected.
