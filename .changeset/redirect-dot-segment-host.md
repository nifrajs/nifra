---
"@nifrajs/core": patch
"@nifrajs/web": patch
---

`redirect()` and the auth guards' `redirectTo` refuse a path whose dot segments resolve it to `//host`, such as `/.//evil.example/x` or `/a/..//evil.example/x` (`isSameOriginPath` is false for them). A redirect answering a client navigation or a JS-enhanced form submit no longer hands the router such a path either: a same-origin target whose path starts with `//` rides `x-nifra-redirect` as an absolute URL, so the browser stays on this origin instead of reading the path as a protocol-relative URL to another host.
