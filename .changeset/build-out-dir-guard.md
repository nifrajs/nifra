---
"@nifrajs/web": patch
---

`buildTarget`, `buildTargetVite` and `buildServerComponents` clear their output directory first, so they now refuse one that is a filesystem root or is or contains the routes directory, the public directory, an absolute entry or backend module, or the working directory, comparing paths after resolving symlinks. `nifra build --out .` fails with an error naming the path instead of clearing the project. `workDir` gets the same check.
