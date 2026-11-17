---
"@nifrajs/middleware": patch
---

`compression()` encodes a buffered string body itself before an inline gzip instead of handing zlib the string, which saves zlib a `Buffer` copy on every compressed reply (0.2 to 0.6 us on an 8 KB JSON body, Bun on Linux). The compressed bytes are unchanged.
