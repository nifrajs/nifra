---
"@nifrajs/core": patch
"@nifrajs/node": patch
---

On Node, `c.text(...)` and `c.json(...)` now defer building the Web `Response`. The adapter writes a
text or JSON body to the socket from a status, a header record, and the bytes directly, so the
`Response` those helpers used to construct up front - about a quarter of the request budget on a
small response - is built only if something actually reads the Web surface (a response hook,
`app.fetch`, or user code touching `.headers`), and forwarded to from then on. The returned value is
still a real `Response`: `instanceof Response` holds, the status, headers, and body are unchanged,
and the content-type is byte-identical to what the eager `Response` carried. Bun and Deno, which hand
the `Response` to their native server, are unaffected. Net: a plain text or JSON return on Node lands
on the adapter's fastest write lane - on the Bun HTTP framework benchmark the text workloads (Ping,
Query) go from roughly 0.75x of Fastify to level with it, and clear of Hono.
