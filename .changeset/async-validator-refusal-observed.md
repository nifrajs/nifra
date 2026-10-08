---
"@nifrajs/env": patch
"@nifrajs/events": patch
---

`defineEnv` and an event contract's `parse` and `create` still refuse an async validator with their synchronous error, and now also observe the validator's promise, so a validator that rejects no longer surfaces as an unhandled rejection after the caller catches the refusal.
