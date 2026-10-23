---
"@nifrajs/core": patch
---

The multipart parser behind `multipartBody` finds delimiters with Buffer's native search on Node and
Bun, where V8's typed-array `indexOf` walks one byte at a time: a 1 MiB file part parses in 560 us
on Node instead of 1,076.
