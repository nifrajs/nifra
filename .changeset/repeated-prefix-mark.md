---
"@nifrajs/core": minor
---

`@nifrajs/core/response-observer` exports `markRepeatedPrefix(chunk, source, length)` and `repeatedPrefixOf(chunk)`. A producer that streams the same leading bytes in many responses marks each chunk that starts with them, and a response observer that transforms streamed bodies, such as `compression()`, may reuse its work on those bytes after checking that the chunk still holds them.
