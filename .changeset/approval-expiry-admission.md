---
"@nifrajs/coding-agent": patch
---

An approval can no longer be granted after it expires. Expiry was enforced only by the timeout timer, so an approve that arrived after the deadline but before a delayed timer ran (a busy event loop, a suspended host) was accepted; `ApprovalManager` now checks the deadline when it admits a decision and denies a late approve with "approval timed out".
