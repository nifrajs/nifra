---
"@nifrajs/core": patch
"@nifrajs/node": patch
---

A `Date` in a JSON answer is written ahead of the runtime's serializer when the answer's first row holds one, so the serializer keeps its fast path; the bytes sent are the same. A `Date` that overrides `toJSON` or a method it calls is still left to the serializer, as is anything JSON writes by rules of its own, such as a boxed primitive or a `JSON.rawJSON` value. Each getter in such an answer still runs once.
