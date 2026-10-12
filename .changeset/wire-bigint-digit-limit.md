---
"@nifrajs/core": patch
---

Decoding transport data now refuses a `bigint` longer than 4,096 decimal digits with `WireDecodeError`. Parsing a long digit string costs more than linear time: a 900 KB token took about 60 ms, and the 16 MiB byte budget allowed far longer. It is reachable from any request body the transport codec decodes. `WireDecodeLimits.maxBigIntDigits` raises or lowers the limit.
