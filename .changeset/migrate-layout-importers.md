---
"@nifrajs/cli": patch
---

`nifra migrate layout` keeps the `;` a file was written with on every import and export it rebuilds. A module that imports a moved export (`loader`, `action`, ...) from a route, a test included, now imports it from the route's backend half, and a statement that also names what stayed is split in two; a namespace or dynamic import that reads a moved name, and `export *`, are reported. When the app is one folder down in a package (`--dir src`), imports in the code beside it that the migration moves or splits out from under them are reported with the new path, and run from the package folder it names the `--dir` to use. A loader or action without an output schema is reported with `nifra schemas --write` as the way to draft one.
