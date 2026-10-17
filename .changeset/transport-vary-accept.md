---
"@nifrajs/core": patch
---

A response `transportCodecs()` negotiates from `Accept` now carries `Vary: Accept`, the JSON fallback included, as `encodeTransportResponse()` already did. A shared cache, `cache()` among them, no longer stores the representation one client asked for and replays it to a client that asked for another: `cache()` bypasses storage unless `vary` includes `accept`, and keeps one entry per representation when it does.
