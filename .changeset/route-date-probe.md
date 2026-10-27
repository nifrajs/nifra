---
"@nifrajs/core": patch
"@nifrajs/node": patch
---

A route that keeps answering without a `Date` stops paying for the probe that looks for one. After 16 such answers in a row the writer looks at one answer in 32, and an answer holding a `Date` makes it look at every answer again. A skipped answer goes to `JSON.stringify` as it came, which writes the same JSON.
