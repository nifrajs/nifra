---
"@nifrajs/core": patch
---

On Bun, a request whose `Host` no URL can be built on (a port past 65535, an IPv6 literal the URL
parser refuses, a value with a space or a path in it) and whose target holds a dot segment or a
backslash is refused 400 `invalid_host`, as Node and Deno refuse it. Bun leaves such a target
unparsed, so `GET /files/../private/me` reached a `/files/*` route with `../private/me` as its
parameter instead of the `/private/me` route. Deno also refuses an IPv6 literal the URL parser
refuses.
