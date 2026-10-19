---
"@nifrajs/middleware": patch
---

The portable/Deno weak ETag fingerprint hashes strings as UTF-8, including replacement of unpaired surrogates, without allocating an encoded copy. String and raw-byte responses now share a validator only for the same bytes; switching between text `Ã©` and raw UTF-8 `é` could previously answer an incorrect 304.
