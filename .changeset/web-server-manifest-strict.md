---
"@nifrajs/web": patch
---

fix: a generated `server-manifest.ts` type-checks under a strict tsconfig

The manifest `generateServerManifest` and `nifra sync-manifest` write for a hand-written server entry
now compiles under `strict` with `noUncheckedIndexedAccess`, including routes with a backend half or
a typed `meta`. Its route table is typed as plain modules and handed to `buildManifest` as route
modules, the same way `discoverRoutes` loads them.
