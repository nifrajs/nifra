---
"@nifrajs/cli": patch
---

`nifra_test` keeps `pattern` inside the selected project. A pattern that resolves outside it, by `../`, an absolute path or a symlink, is refused before `bun test` starts.
