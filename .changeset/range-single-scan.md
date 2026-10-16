---
"@nifrajs/core": patch
"@nifrajs/node": patch
---

`parseByteRange` from `@nifrajs/core/range` answers a single `bytes=<first>-<last>` range with one scan of the header, about 5x faster on Node and 4x on Bun. Every answer is unchanged. Range sets, spaces around `=` and anything else still go through the full parser. `@nifrajs/node`'s `static` reader runs the same parser.
