---
"@nifrajs/cli": minor
---

`nifra upgrade 5.0.0` pins the fixed group to 5.0.0 and prints each changed default with the `nifra check` finding or the one-line setting that keeps the 4.x behavior: the backend's `apiPrefix` (NF-C035), status pages inside their layouts (NF-C034, `inLayouts = false`), the WebSocket handshake's route chain, per-request Response ownership, and the optional `invariants.executor`.
