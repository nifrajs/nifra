---
"@nifrajs/cli": patch
---

`nifra review --diff` no longer passes a change while the project has a type error in a file outside the diff. A change can break a caller it never touched, so the `typecheck` check reports `unavailable` with reason `filtered-out-of-scope` and the review is `inconclusive`. The text report names the reason next to each unavailable check.
