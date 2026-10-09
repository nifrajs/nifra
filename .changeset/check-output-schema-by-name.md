---
"@nifrajs/cli": patch
---

`nifra check` reads an output schema given by name. `export const loaderOutput = userOutput` (or `output: userOutput` on a server function) passed NF-C031 even when `userOutput` named a credential field, because only the text after the `=` was read. The check now follows a bare name to its top-level declaration in the same file, through aliases, and reports each sensitive field once.
