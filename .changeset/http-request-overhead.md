---
"@nifrajs/core": patch
"@nifrajs/node": patch
---

Reduce URL-splitting overhead while preserving query and fragment semantics.
Reduce Node request-body listener allocations with isolated per-read state, retaining
body replay, abort handling, and byte-limit enforcement.

Release queued JSON traversal references immediately when rejecting a poisoned body. Keep the
native array stack and the same iterative security checks on every runtime. Avoid repeated
validation callback allocations, and reduce encoded-query iterator work while preserving decoding,
repeated keys, and null-prototype records.
