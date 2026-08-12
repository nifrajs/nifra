---
"@nifrajs/core": patch
---

Walk arrays by index in the prototype-poisoning guard.

A JSON body that is mostly array data was walked through the array iterator protocol, which JSC does
not elide: on Bun a 9KB array of numbers cost 27us to guard instead of 2.2us, and the gap scaled
with the body cap. The guard now indexes the array directly, which measures identically on V8 and
removes the amplification on JSC.
