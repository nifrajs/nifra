---
"@nifrajs/cli": patch
---

`nifra migrate layout --write` runs on a machine without git, falling back to the app's own `.gitignore` to decide whether `.nifra/` is ignored. It now removes only the folders its moves emptied, leaving folders that were already empty in place.
