---
"@nifrajs/core": patch
---

Reconciling the in-memory effect and saga stores, or a store that only implements `list()`, no longer skips records. Their scan cursor was an offset into the matching records, so a page reconciled before the next was read shifted the rest past it: 250 stale effects in pages of 100 reached the handler only 150 times. The cursor is now the last id returned, as with the durable adapters, and these scans return records in id order.
