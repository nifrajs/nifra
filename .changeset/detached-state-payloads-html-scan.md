---
"@nifrajs/agent": patch
"@nifrajs/jobs": patch
"@nifrajs/web": patch
---

Detach shared-state patch values and subscriber batches so callers and observers cannot mutate live state without a new patch. Reject values that cannot be cloned before committing a batch.

Snapshot in-memory job payloads when enqueuing and leasing, preserving validated input across caller mutations and retries. Payloads must be structured-cloneable.

Keep server-component HTML scanning linear when a tag has many attributes while retaining case-insensitive duplicate detection.
