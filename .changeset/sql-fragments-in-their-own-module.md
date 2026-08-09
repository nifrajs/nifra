---
"@nifrajs/cli": minor
---

`nifra check`'s interpolated-SQL rule follows a query fragment into the module that exports it. A project that keeps its column lists and order clauses in a `sql-fragments.ts` and imports them by name no longer gets an error on every query assembled from them, so the rule's errors stay the ones worth reading.

Resolution stops wherever proof does, because a wrong resolution here silences a real SQL injection rather than reporting a false one. It follows `export const NAME = "…"`, the two-statement `const NAME = …; export { NAME }`, and barrels (`export { NAME } from`, `export *`), reached by a named import from a relative specifier that lands on real source inside the project. Everything else still flags: a default or namespace import, an exported `let`, an initializer that is a call, a bare specifier (a dependency's exports are not the project's to prove), two `export *` sources offering the same name, a chain longer than three modules, a cyclic barrel, a file that does not parse, and a local binding that shadows the import. A resolved fragment still feeds the keyword scan, so hostile SQL parked in a shared constant is found rather than trusted, and the fragment's own identifiers are read in its own module - never in the file that imported it.
