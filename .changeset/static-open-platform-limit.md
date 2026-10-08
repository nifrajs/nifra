---
"@nifrajs/node": patch
"@nifrajs/image": patch
"@nifrajs/web": patch
---

On platforms other than macOS and Linux, Windows included, the check that a static, `public/` or local image file is still the file at its resolved path now runs its steps one after another and compares file identities exactly, so a single directory swap during the open cannot pass it. A race-free check does not exist there, because no file API can open a path without following a link in a middle directory; the `@nifrajs/node` README states that a tree a concurrent local writer can change is outside the guarantee on those platforms.
