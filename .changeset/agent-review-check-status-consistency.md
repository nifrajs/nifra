---
"@nifrajs/agent-review": patch
---

`parseReviewReport` and `composeReviewReport` refuse, with `derived-field-mismatch`, a check whose `pass` or `fail` status disagrees with whether it references an error finding. A required check marked `fail` with no error finding can no longer compose a passing report.
