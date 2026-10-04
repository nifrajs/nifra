---
"@nifrajs/core": minor
---

Route idempotency (`schema.idempotency`) releases a key when the handler answers 401, 403, 408, 409, 425, or 429 without an owned effect having begun, as it already did for a request refused before the handler. Each of those statuses says the request was not carried out, so a retry under the same key runs again, and callers who are refused no longer keep store entries for the full TTL.

A response whose body fails while it is being stored no longer leaves its key in progress until the TTL ends. With no owned effect begun the key is released; once one began, the key keeps a terminal 500 that a retry replays.

`MemoryIdempotencyStore` takes `maxEntriesPerNamespace`. Past it, only that namespace's new keys are refused, so one tenant or principal cannot use up `maxEntries` for the rest.
