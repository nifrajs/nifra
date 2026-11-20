---
"@nifrajs/cli": minor
"@nifrajs/core": patch
---

`nifra check` reports `NF-C061` (info) for an SSE stream that sends no ping inside Bun's 10-second idle timeout, in a project served by `listen()` or `Bun.serve()`. A Bun listener closes a connection that moves no bytes for `idleTimeoutSec`, so a quiet `sse()` stream is cut, and a test through `app.fetch` never shows it. The rule stays quiet when the project uses `withIdleTimeout` or sets `idleTimeoutSec`. The `keepAlive` doc now says it has no default and names the Bun cut, and the streaming examples ping every 5 seconds instead of 15.
