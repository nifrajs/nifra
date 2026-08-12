---
"@nifrajs/middleware": minor
---

The default idempotency store key is now scoped by a digest of the caller's credential headers as
well as by method + path. Presenting another caller's `Idempotency-Key` used to address their stored
entry and replay their response; it now addresses a different key entirely. The headers that identify
a caller are configurable via `principalHeaders` (default: Authorization, Cookie, x-api-key), and only
a SHA-256 digest ever becomes part of a key - a raw credential as a store key would show up in every
Redis `KEYS` dump and slow-log line. A custom `key` still replaces the scoping wholesale and must fold
in the principal itself; it may now be async.

`MemoryIdempotencyStore` is bounded: `maxEntries` (default 10,000) and `maxKeyBytes` (default 1024).
Reaching the cap refuses rather than evicts - every entry is a live lock or a response someone is
entitled to replay, so evicting to make room is how a duplicate charge happens - and the middleware
answers `503 idempotency_unavailable` with `retry-after`. Expired entries are swept incrementally, so
a normal request never walks the map.
