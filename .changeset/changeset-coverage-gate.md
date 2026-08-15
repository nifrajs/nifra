---
"@nifrajs/cli": patch
---

A new `check:changesets` gate fails when a package's source changed since the last release without a changeset naming it. Versioning is fixed across the workspace, so an undeclared package still bumps - it just ships with a changelog that says nothing about what moved, which is how a consumer upgrades into a change no release note mentions. The gate anchors on the last release commit in git history, so it needs no tag, base ref, or network, and it runs in `nifra check` release mode as well as CI.
