---
"@nifrajs/core": minor
---

feat(core): validation failures now return **422**, plus a params-decode fast path

**Behavior change:** a request that fails a route's `body`/`query` schema validation is now rejected
with **`422 Unprocessable Entity`** (previously `400`). The response body shape is unchanged
(`{ ok: false, error: "validation", issues }`). If your client branches on `status === 400` for
validation failures, switch it to `422`. Genuinely malformed requests keep their existing codes —
invalid JSON via `boundedJson` and an undecodable path are still `400`.

Also: route params skip the `decodeURIComponent` pass entirely when the pathname contains no `%`
(the overwhelmingly common case) — same behavior, less per-request work, on both the HTTP and
WebSocket-upgrade paths.
