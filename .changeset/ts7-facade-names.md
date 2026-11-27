---
"@nifrajs/cli": patch
---

`nifra check` on a TypeScript 7 project no longer fails closed with `ts.isTypeAssertionExpression is not a function` (NF-C017) in a file that imports `Href`. The TypeScript 7 compiler facade now also answers `isMethodSignature`, `isPropertySignature`, `canHaveModifiers` and `getModifiers`, which the same scanners call under their TypeScript 5/6 names.

Generated output schemas now tolerate compiler differences in object field order, including when field order affects a union whose branches have no date decoding. NF-C033 still reports changes to omitted fields and changes to union order that can affect how dates decode.
