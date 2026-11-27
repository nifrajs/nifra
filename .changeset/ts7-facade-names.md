---
"@nifrajs/cli": patch
---

`nifra check` on a TypeScript 7 project no longer fails closed with `ts.isTypeAssertionExpression is not a function` (NF-C017) in a file that imports `Href`. The TypeScript 7 compiler facade now also answers `isMethodSignature`, `isPropertySignature`, `canHaveModifiers` and `getModifiers`, which the same scanners call under their TypeScript 5/6 names.

A generated output schema that differs from the new one only in the order of object fields now counts as current. TypeScript 5/6 and 7 order the properties of a merged type differently, so switching compiler reported NF-C033 for schemas that declare the same thing.
