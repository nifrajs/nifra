---
"@nifrajs/web": patch
---

fix(web): the browser-build credential scan also flags hyphenated header keys. A random-looking literal under a quoted name such as `"x-api-key"` or `'x-auth-token'` now fails the build like `apiKey: "..."` does; the name must be the whole quoted string, so a ternary branch or a label that only mentions a header is not a target. An `Authorization` (or `Proxy-Authorization`) literal fails when it carries a random-looking Bearer token, or a Basic `user:password` that is not a placeholder (`user:password`, a user name repeated as the password). Names ending in `access-key`, `signing-key`, `encryption-key`, `master-key`, `service-account-key` or `connection-string` count when spelled with hyphens or underscores too.
