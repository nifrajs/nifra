---
"@nifrajs/core": patch
"@nifrajs/node": patch
---

A `Date` in a JSON answer is written ahead of the runtime's serializer when the answer's first row holds one, so the serializer keeps its fast path; the bytes sent are the same. A `Date` that overrides `toJSON` or a method it calls is still left to the serializer.
