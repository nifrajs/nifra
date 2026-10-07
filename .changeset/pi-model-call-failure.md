---
"@nifrajs/pi": patch
---

A Pi turn whose model call fails now ends with `session.failed` (`recoverable: true`) instead of `session.completed` with no assistant message. The error code is `PI_AUTH_REQUIRED` when Pi's provider login or API key was rejected (for example an expired ChatGPT sign-in), and `PI_MODEL_FAILED` otherwise; the message is the first line of Pi's error, never the provider response body below it. A model call Pi aborts ends with `session.stopped`, and a transient error Pi retries (`agent_end` with `willRetry: true`) keeps the turn open until the retry settles.
