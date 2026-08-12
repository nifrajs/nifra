---
"@nifrajs/middleware": patch
---

`jwt()` now verifies that a `CryptoKey` passed as the verification key actually matches the algorithm
being verified. A key imported for one algorithm was previously used as-is for whichever `alg` the
configuration named, so an HMAC secret could be handed to an RS256 verification (and vice versa),
turning the algorithm choice into something the key no longer pins down. The key's `type`,
`algorithm.name`, `algorithm.hash`, and `verify` usage must all line up, or the token is rejected with
a JWT error. Raw string and `Uint8Array` secrets are imported by the middleware itself and were
already bound.
