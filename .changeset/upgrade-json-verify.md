---
"@nifrajs/cli": patch
---

`nifra upgrade --write --json` now prints one JSON document: the post-upgrade check result is included as `check` instead of being printed as a text report after the JSON.
