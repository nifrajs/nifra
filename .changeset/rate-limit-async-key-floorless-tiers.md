---
"@nifrajs/middleware": minor
---

A rate limit `key`, on `rateLimit`, on `rateLimitTiers` or on one tier, may now return a promise, so a
bucket can follow a session whose signed cookie is verified with WebCrypto first. A key that throws or
rejects is charged to the client IP the default key derives, so an unverified cookie never mints a
bucket of its own; with no client IP either, the request is refused with a `500`, as an unkeyable
request already was. A key that returns a string is not awaited.

`rateLimitTiers` no longer requires a `floor`. Without one, a request no tier claims is not charged and
carries no `RateLimit-*` headers, for apps whose edge or shell already applies a base limit. Its
rate-limit route evidence then covers only the routes under a tier. A limiter with neither a floor nor
a tier is refused when it is built.
