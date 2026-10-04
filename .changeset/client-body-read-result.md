---
"@nifrajs/client": patch
---

A response body that fails to arrive after its headers - the call's `timeoutMs` running out, the caller's `signal` aborting, or the connection dropping - returns `{ ok: false, status: 0, error: { error: "timeout" } }` or `{ error: "network_error" }`, as a failed fetch does, instead of throwing.
