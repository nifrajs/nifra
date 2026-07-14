---
"@nifrajs/core": minor
---

Harden the idempotency primitive and add field-level response classification.

Idempotency now isolates keys per server-resolved namespace (a static string or a
`(request, platform) => string` resolver — never a client header), so the same client key cannot
collide across tenants. `begin` returns an opaque reservation token that `complete`/`abandon` must
present, so an expired-and-re-reserved key can no longer be overwritten by an older in-flight request.
Stored responses are captured under a byte bound (`maxResponseBytes`, throwing
`IdempotencyResponseTooLargeError`), fingerprints canonicalize JSON bodies and bind the content type,
and a store advertises an honest `durability` marker — a route declaring `scope: "durable"` is rejected
at registration unless its store is durable. SSE routes cannot be idempotent.

`classified(schema, tag)` attaches field-level sensitivity that survives composition through nested
objects, arrays, and unions; reflection exposes both the JSON-pointer field tags and the maximum
(`public` | `pii` | `secret`). Route-level `schema.classification` remains the fallback, and the
capability lockfile continues to record the maximum.
