---
"@nifrajs/storage": patch
---

On Windows, a `FileStorage` read no longer serves one put's body with another put's content type and metadata when two instances put one key at once. The sidecar names its body by file ID, read as a JavaScript number; an NTFS file ID can pass 2^53, where two different files round to the same number, so a sidecar could match the other put's body (2 of 200 contended reads on a CI runner). File IDs are now read exactly.
