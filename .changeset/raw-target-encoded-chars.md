---
"@nifrajs/core": patch
"@nifrajs/node": patch
---

A raw request target with a character a URL parser percent-encodes in a path (`"`, `<`, `>`, `^`, `` ` ``, `{`, `}`, a control, space or non-ASCII) now routes the same on every runtime. Bun and workerd route the parsed path, so `GET /vault<tag>` reached a route registered as `/vault%3Ctag%3E` there, while Node, Deno and Bun's native route table matched the raw text and could pick a broader `/:id` route with different guards. Node and Deno now encode such a target before anything reads it, and Bun's native table hands a param holding one of those characters to the portable router.
