---
"@nifrajs/cli": patch
---

`nifra doctor --fix` re-points a path dependency it copies from an ancestor `package.json` (`file:`, `link:`, `portal:`, or `./`/`../` specs) so the copy names the same directory from the package being fixed. Previously the spec was copied unchanged and resolved against the wrong directory. Version ranges and `workspace:` specs are copied as before.
