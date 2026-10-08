---
"@nifrajs/core": patch
---

`reflectHooks` and `nifra routes --hooks` list each WebSocket route as `WS /path` with the hooks its handshake runs: the request hooks, then the authentication stages, `derive`s, `beforeHandle`s and `onError` declared before it. `nifra upgrade` and `--since` diffs include them.
