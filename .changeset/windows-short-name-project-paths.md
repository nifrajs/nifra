---
"@nifrajs/cli": patch
---

On Windows, `nifra fix`, `nifra review --sarif` and the other project path checks accept a project whose directory path has an 8.3 short name in it (such as `C:\Users\RUNNER~1`). The dangling-symlink check above compared the project root and the path through two canonicalizers, one that expands short names and one that keeps them, so every path in such a project read as outside it. Both sides now go through the same one.
