---
"@nifrajs/cli": patch
---

`nifra upgrade`'s downgrade guard now respects prerelease precedence, so a target of `2.3.0-beta` is correctly treated as older than an installed `2.3.0` and blocked without `--allow-downgrade`. Previously only the numeric core was compared, so a release-to-prerelease step slipped past the guard.
