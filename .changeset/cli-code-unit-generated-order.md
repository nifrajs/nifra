---
"@nifrajs/cli": patch
---

`nifra contracts snapshot` writes `contracts.lock.json` routes, and `nifra sdk` emits operations, in code-unit order instead of `localeCompare` order, so the files a project commits come out the same on every machine. A lock or SDK whose routes the two orders rank differently (mixed case, `-` beside `_`) is reordered once when it is next written; `nifra contracts check` compares routes by key and is unaffected.
