---
"@nifrajs/agent": patch
"@nifrajs/web": patch
---

Detach shared-state patch values and subscriber batches so callers and observers cannot mutate live state without a new patch. Each observer receives its own copy of a batch. Reject values that cannot be faithfully cloned, including shared memory and custom prototypes, before committing a batch.

Keep server-component HTML scanning linear when a tag has many attributes while retaining case-insensitive duplicate detection.
