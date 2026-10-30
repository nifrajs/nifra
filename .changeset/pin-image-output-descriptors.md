---
"@nifrajs/image": patch
"@nifrajs/web": patch
---

Prevent check/use races in build-time and development image output. Create assets with exclusive, no-follow opens; validate and read existing content through the held descriptor; refuse swapped files/directories and bound verification reads. Add deterministic symlink-swap regressions. Fix new-file lint violations and restore imported-image resolver coverage without changing lint or coverage baselines.
