---
"@nifrajs/cli": minor
"@nifrajs/web": patch
---

`nifra doctor` flags a `buildManifest(...)` call whose file list, an array literal or
`import.meta.glob` patterns, reaches a page under `routes/` but not the `.backend.*` half beside it.
`buildManifest` pairs the halves only from the list it is given, so such a manifest serves that page
without its loader, action and guards, which a test then passes against. The advisory names the
missing halves and points to `discoverRoutes(dir)` from `@nifrajs/web/fs` or the generated
`server-manifest`. It never fails the run. The testing guide documents both as the way to give a test
the routes the app serves.
