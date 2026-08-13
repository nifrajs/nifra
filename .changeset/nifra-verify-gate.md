---
"@nifrajs/cli": minor
---

Add `nifra verify`, one command that runs the repository verification gate. `--release` runs the full
build, test, coverage, corpus, consumer, and cross-runtime set; the default runs a fast lint,
typecheck, and test pass. `--json` emits a machine-readable result carrying each gate's status and
remediation, so the same gate serves humans, CI, and agents.
