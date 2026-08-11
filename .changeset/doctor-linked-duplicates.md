---
"@nifrajs/cli": minor
---

`nifra doctor` follows linked dependencies when looking for duplicate installs. A package linked in
from a sibling repo (`link:`, `npm link`, a local file dependency) resolves through a symlink that
leaves the workspace, and the copies of `@nifrajs/*` installed inside that sibling were invisible to
the duplicate check - the exact shape that produces two incompatible copies of core in one build.
Doctor now resolves each linked dependency to its real path, probes it for identity-sensitive
packages, and reports every copy with the path it was found at. The scan is bounded (linked roots
and probes are capped) and stays inside the linked package's own repository.
