---
"@nifrajs/web": minor
"@nifrajs/core": minor
---

The Vite dev server, `buildClientVite` and `buildServerVite` apply the `package.json` single-copy declaration (`"nifra": { "singleCopy": [...] }`): each declared package, and each package installed under a declared `@scope/*`, joins `resolve.dedupe`, so a linked package with its own copy loads the app's copy, as the Bun build does. `singleCopyPackageNames(cwd)` from `@nifrajs/core/single-copy` returns that list.
