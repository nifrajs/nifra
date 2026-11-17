---
"@nifrajs/agent": patch
"@nifrajs/jobs": patch
"@nifrajs/web": patch
---

Detach shared-state patch values and subscriber batches so callers and observers cannot mutate live state without a new patch. Reject values that cannot be faithfully cloned, including shared memory and custom prototypes, before committing a batch.

Snapshot in-memory job payloads when enqueuing and leasing, preserving validated input across caller mutations and retries. Payloads must support a detached data snapshot: shared memory, custom prototypes, accessors, and fields omitted by structured cloning are rejected before storage. Ordinary objects and arrays, dates, maps, sets, and non-shared buffers and views are supported when their fields survive cloning.

Keep server-component HTML scanning linear when a tag has many attributes while retaining case-insensitive duplicate detection.
