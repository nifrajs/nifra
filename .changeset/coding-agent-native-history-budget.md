---
"@nifrajs/coding-agent": patch
---

`NifraBackend` takes a `maxHistoryChars` option (default 1 MiB) that caps the conversation a session sends to the model. Past it, whole earlier turns are dropped, oldest first; the current turn is always sent in full. Each model request gets a frozen snapshot of the history without re-copying every message.
