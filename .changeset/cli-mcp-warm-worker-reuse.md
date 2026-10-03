---
"@nifrajs/cli": patch
---

`nifra_run` and `nifra_render` with `warm: true` reuse one hot worker for the whole MCP session, as documented, instead of starting a new one per call. The source fingerprint that restarts the worker on a change no longer walks `node_modules`, build output or dot directories.
