---
"@nifrajs/web": patch
---

Duplicate-install detection (`NF-C009` / `NF-D001`) no longer sweeps an unrelated sibling repository.

A dependency symlinked into another project's package store (bun's `node_modules/.bun/<pkg>@<version>`, an `npm link` target, a shared global store) was treated as a linked source checkout, so the scan walked up to that project's `.git` and reported its whole dependency tree as duplicates of the project being checked - findings in a repo the developer is not working in, that no change in their own project could ever clear. A linked root that resolves inside a `node_modules` directory is now clamped to itself: only its own nested `node_modules` is scanned, which is exactly the set of modules it can load. The store copy itself is still reported, because it is genuinely what the project resolves; a real linked source checkout (`link:../../pkg`) still has its whole repo scanned, because its imports really do resolve there.
