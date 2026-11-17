---
"@nifrajs/jobs": minor
---

`MemoryJobStore` copies a job's payload when it is enqueued and again when it is leased, so a caller's later changes and a failed handler's changes no longer reach the stored payload or the next attempt. A payload must be plain data that survives a structured clone intact: one that holds a function, a class instance or null-prototype object (a copy would lose its prototype), an accessor, an `Error`, or a `SharedArrayBuffer` (a copy would still share its memory) is now refused with a `TypeError` and no job is stored. Pass such values as an identifier and rebuild them in the handler.
