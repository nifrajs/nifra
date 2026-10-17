---
"@nifrajs/uploads": patch
---

`signDownloadUrl()` rejects, with a `RangeError`, an `expiresInSeconds` that is not a whole number of seconds of at least 1, a `now` that is not a whole, non-negative number of unix seconds, and an expiry past the largest safe integer. It used to sign such values into a `vexp` that `verifyDownloadUrl()` never accepts, so `expiresInSeconds: 0.5` produced a link that was dead on arrival.
