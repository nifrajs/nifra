---
"@nifrajs/node": patch
---

A field sent more than once whose last value is empty now reads the same through `c.req.headers` as
on Bun and Deno, and as `c.header()` already did: `x-caller: a` then `x-caller:` is `"a, "` (and
`cookie` is `"a=1; "`), where it read `"a,"`.
