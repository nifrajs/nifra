---
"@nifrajs/core": patch
---

A JSON request body that is not valid UTF-8 now fingerprints its exact bytes for idempotency. Two such bodies that differed only in their invalid bytes, such as `0xff` and `0xfe` inside a string, used to decode to the same replacement character and share a fingerprint, so a retry that reused a key with the other body replayed the first response instead of being refused with 409. A body that contains the replacement character U+FFFD itself also fingerprints its exact bytes. Every other body, with or without a leading byte order mark, keeps its fingerprint.
