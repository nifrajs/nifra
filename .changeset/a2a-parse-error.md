---
"@nifrajs/a2a": patch
---

A request body that is not JSON, or that carries a `__proto__` key, now answers a JSON-RPC parse
error (`-32700`, `id: null`) like every other A2A error, instead of a plain HTTP 400
`{ ok: false, error: "invalid_json" }` that an A2A client cannot read as a reply.
