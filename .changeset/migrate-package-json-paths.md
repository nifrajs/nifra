---
"@nifrajs/cli": patch
---

`nifra migrate layout` rewrites the moved files the app's own `package.json` names by exact path in `main`, `module`, `types`, `browser`, `source`, `bin`, `exports`, `imports`, `files` and `scripts`, keeping a written `./`, and lists the change under `tooling`. A value with a `*` outside `scripts` is a pattern over a folder and stays, as do `"//"` note keys; the path scan still reports what stays.
