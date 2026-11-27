---
"@nifrajs/cli": patch
---

`nifra check` on a TypeScript 7 project no longer fails closed with `ts.isTypeAssertionExpression is not a function` (NF-C017) in a file that imports `Href`. The TypeScript 7 compiler facade now also answers `isMethodSignature`, `isPropertySignature`, `canHaveModifiers` and `getModifiers`, which the same scanners call under their TypeScript 5/6 names.

A generated output schema that differs only in the order of object fields or union members now counts as current. TypeScript 5/6 and 7 can order the properties of a merged type differently, which can also reorder union members. NF-C033 still reports changes to the fields a generated schema omits.
