---
"@nifrajs/web": minor
---

`RouterState.documentLoad` names a URL to load as a document when the page on screen was loaded for the previous visitor and a load for the visitor now here failed: its reload, or a navigation or submit away from it. `installHistory` loads it in place of the current history entry; without it, the router keeps what it shows and sets the flag. A form a visitor change caught before its POST reached the server is not posted again for the new visitor.
