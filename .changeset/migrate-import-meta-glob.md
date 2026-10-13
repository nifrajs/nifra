---
"@nifrajs/cli": patch
---

`nifra migrate layout` reads `import.meta.glob`: the files a literal pattern loads count as imports of the module that loads them, so they move with it, and each pattern is checked after the moves. One whose files moved together into another folder is re-pointed there (`!` exclusions included); one whose files no longer sit under one folder, or a computed pattern, is reported instead of silently matching nothing.
