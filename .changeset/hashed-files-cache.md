---
"@nifrajs/web": minor
"@nifrajs/node": minor
---

The Bun and Node servers that `buildTarget` generates cache only the client build's content-hashed outputs as immutable. A file copied from `public/` into `/assets/` now gets the one-day asset policy, so the browser revalidates it after a deploy. `servePublicDir` takes a `hashedFiles` set, and `serve`'s `static` mount takes `hashedFiles`, so a build manifest's `assets` list can decide which files are immutable. Without the list, both keep their prefix behavior.
