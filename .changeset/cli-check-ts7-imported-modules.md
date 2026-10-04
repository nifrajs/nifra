---
"@nifrajs/cli": patch
---

`nifra check` on a project using TypeScript 7 completes when it follows an import into a module outside the scanned set, such as a `.js` helper with its own imports. Previously the whole check stopped with "TypeScript 7 source file was not preloaded". The import scan reads such a module with its lexical rule. For the SQL scan, such a module proves no constant, the same as a module that does not parse.
