---
"@nifrajs/web": minor
"@nifrajs/cli": patch
---

feat(web): the app's package.json can set zones with `"nifra": { "zones": { ... } }`. `packages` gives a side to packages that do not declare one, by exact name or a trailing-`*` prefix (`"@shop/*": "library"`); a package's own declaration still wins. `backend`, `frontend` and `shared` list extra app folders that count as that zone folder (`"backend": ["migrations"]`). Every build, dev server, `nifra check` and the TypeScript plugin read the setting; an invalid one fails with the exact key. An undeclared package is now reported once for the whole package, in the build and in `nifra check`, instead of once per file.
