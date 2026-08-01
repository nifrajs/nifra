---
"@nifrajs/web": minor
---

Ambient types for a generated `server-manifest` module, so a hand-written server entry that imports `./server-manifest` typechecks before the first build has generated that file - no `@ts-nocheck` on the file that deploys. Reference it with `/// <reference types="@nifrajs/web/server-manifest" />`, or list `"@nifrajs/web/server-manifest"` in your tsconfig `compilerOptions.types`. Once a build (or `nifra sync-manifest`) writes the real file next to your entry, TypeScript resolves the import to it and its types win. Not needed with `nifra build --target`, which generates and bundles its own entry.
