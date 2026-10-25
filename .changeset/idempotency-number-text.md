---
"@nifrajs/core": patch
---

An idempotency fingerprint now tells apart JSON bodies whose numbers differ only past what a double holds, such as `12345678901234567890` and `12345678901234567891`, `4e-324` and `5e-324`, or `1e-400` and `0`, so a retry that reuses a key with such a different body is refused with 409 instead of replayed. Such a number, one written with 16 or more digits in a row (a decimal point counted) or with a negative exponent of 3 or more digits, now enters the fingerprint as written rather than as the rounded double. A body holding one can therefore get a new fingerprint, and a retry of it stored before the upgrade is refused as a reused key. Every other body keeps its fingerprint.
