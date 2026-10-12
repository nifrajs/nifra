---
"@nifrajs/runner": patch
---

`runApp()` sends a `ReadableStream` request body on Node, which requires `duplex: "half"` on a streamed `Request`; it failed there with `TypeError: RequestInit: duplex option is required when sending a body.` before reaching the app. Bun, Deno and browsers accepted it already.
