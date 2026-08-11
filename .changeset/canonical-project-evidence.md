---
"@nifrajs/core": minor
"@nifrajs/cli": minor
---

Canonical project evidence: a single reflected snapshot of a project's routes, schemas, assurance,
and capabilities, exported as `@nifrajs/core/evidence` (`snapshotProjectEvidence`). Tools that used
to reflect the app a second time now project from the snapshot instead, so the manifest, the check
report, and introspection cannot disagree about what the app declares.

`createManifest` accepts the snapshot as `evidence` and skips its own reflection when given one. It
refuses to emit a manifest whose route-assurance or capability evidence is failing, so a manifest is
never a record of a project that does not pass its own gates. The previous `source` input still
works; one of the two is required.
