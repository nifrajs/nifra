---
"@nifrajs/a2a": patch
---

A `maxOutputBytes` above the 4 MiB default now applies to `SendMessage` and `GetTask` responses. A larger result was answered with `500 { "error": "response_too_large" }` even when the configured limit allowed it.
