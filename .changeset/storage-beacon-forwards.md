---
"@nifrajs/storage": patch
---

`withCapabilityBeacon` no longer deletes an adapter's optional capabilities.

It assembled its return value from five hand-listed methods, so wrapping a presignable or movable
adapter silently dropped `presign`, `listPage`, `copy` and `move`. A certified S3 adapter came back
unable to sign a URL - no error, no option, and `presign` is the method most worth beaconing, since a
PUT URL hands out write access.

Forwarding is now by Proxy, which cannot miss a method by construction, and the wrapper is generic so
the wrapped type keeps its extensions. `presign` announces read or write by its `operation` argument;
`listPage` reads; `copy` and `move` write; a method nobody mapped announces write, because a
declaration says what a route MAY do and an unmapped extension should fail closed against a read-only
route rather than slip through unannounced.
