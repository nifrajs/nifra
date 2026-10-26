---
"@nifrajs/schema": patch
---

`compileSchema` output typechecks under `strict` TypeScript, `noUnusedLocals` and `noUnusedParameters` included, and Node loads it with its built-in type stripping. An array check no longer annotates its `for...of` binding (TS2483, which Node's type stripping also refuses), the import line names only what the module uses, and the schema literal converts to the source schema's type through `unknown` instead of failing TS2352. A schema whose own text holds the statement `for(const value: any of array)` is refused.
