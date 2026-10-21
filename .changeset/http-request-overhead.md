---
"@nifrajs/core": patch
"@nifrajs/node": patch
---

Reduce URL-splitting overhead while preserving query and fragment semantics.
Reduce Node request-body listener allocations with isolated per-read state, retaining
body replay, abort handling, and byte-limit enforcement.

Reduce Bun's JSON prototype-guard stack bookkeeping while retaining the same iterative security
checks and Node's native array stack. Avoid repeated validation callback allocations, and reduce
encoded-query iterator work while preserving decoding, repeated keys, and null-prototype records.

Reuse a bounded Bun traversal buffer while clearing popped references immediately; rejected input
still clears pending work. Preserve Node's existing reset behavior for deeply nested bodies.
