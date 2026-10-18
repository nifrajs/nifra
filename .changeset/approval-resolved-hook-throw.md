---
"@nifrajs/coding-agent": patch
---

An `onResolved` hook that throws synchronously no longer escapes from `ApprovalManager`. The decision already stood, but the throw surfaced from `resolve()` and `resolveMatched()`, stopped `close()` before it had denied every pending approval, and was raised from the expiry timer. A synchronous throw is now contained the same way a rejected promise from the hook already was.
