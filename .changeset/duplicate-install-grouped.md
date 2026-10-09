---
"@nifrajs/cli": patch
---

`nifra check` reports packages duplicated with the same cause and install topology as one `duplicate-install` finding: the message names every package, and the fix and suggested config carry one `singleCopy` list covering all of them. `identityPreflight` in `--json` output still lists each package.
