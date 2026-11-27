---
"@nifrajs/cli": patch
---

`nifra check` on a TypeScript 7 project no longer fails closed with `ts.isTypeAssertionExpression is not a function` (NF-C017) in a file that imports `Href`. The TypeScript 7 compiler facade now also answers `isMethodSignature`, `isPropertySignature`, `canHaveModifiers` and `getModifiers`, which the same scanners call under their TypeScript 5/6 names.

Generated output schemas now tolerate compiler differences in object field order and draft union members in a stable order. NF-C033 still reports changes to omitted fields and to union order when it can affect date decoding. A date-bearing union drafted in a different order may need regeneration.
