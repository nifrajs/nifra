---
"@nifrajs/core": minor
---

On Bun, a request whose Host Node and Deno refuse is served unless the app sets `server({ validateHost: true })`: one sent twice, one no URL can be built on (a space, a byte past ASCII, a port past 65535, an IPv6 literal no parser takes), or a percent-encoded or sub-delimiter one. With the option, such a request is answered `400 invalid_host`, an HTTP/1.0 request with no Host is served as `localhost`, and an empty Host is refused from the first request a process serves. The check reads the Host on every request, so it is off by default. Without it, a target with `.` or `..` segments is still checked, so a dot segment is never routed raw. Node and Deno refuse these Hosts either way.
