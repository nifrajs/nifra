---
"@nifrajs/core": minor
"@nifrajs/cli": minor
---

API breaking-change gate: `snapshotRoutes` + `diffRouteSnapshots` in `@nifrajs/core/diff` (direction-aware — a new required request field or a removed response field breaks; widening a request enum or adding a response field doesn't; fails closed on anything unprovable), and `nifra snapshot` / `nifra diff <baseline>` CLI commands that exit non-zero on breaking changes for CI.
