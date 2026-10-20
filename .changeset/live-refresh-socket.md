---
"@nifrajs/web": minor
---

A live runtime now serves one WebSocket per tab at `/_nifra/live` (`live.path`). A tab watches the grants its live loads returned and hears `changed` for the tags of those keys only, with no data, key text, subject or sequence number on the wire; `ready` reports which of its owners changed while it was loading. `live.publish(...keys)` announces a change once the write is visible to loaders. `live.revoke` and `live.revokeAll` close the affected sockets, and `live.revokeKey` sends one final change and stops every affected socket hearing that key. Processes share changes and revocations through `live.bus`, a `LiveBus`; the default `memoryBus()` serves one process. Sockets are capped by `maxSockets` (10,000) and optionally by resident memory (`maxRssBytes`), each socket's watches, frames and outbound buffer are bounded, and reload spreading takes `instances`, `reloadRate` and `spreadFloor`.
