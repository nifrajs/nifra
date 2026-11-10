---
"@nifrajs/web": minor
---

A route's `allowedOrigins` function receives, as its second argument, whether the default same-origin check would admit the request. A route can now accept its own site and one more origin, such as a native shell's, with `(origin, sameOrigin) => sameOrigin || origin === shell`. `serverFetch` sends its headers and credentials only to requests for its own origin, so a call to another host never carries the server's bearer token.
