---
"@nifrajs/coding-agent": patch
---

`NifraBackend` refuses an approval that arrives after `approvalTimeoutMs`, as `ApprovalManager` already does. Its deadline was enforced only by a timer, so an approve that came after the deadline while that timer had not yet run (a busy event loop, a suspended host, an `approval` callback settling late) was granted and the tool ran. The decision is now checked against the deadline when it is admitted and reported as `approval timed out` with `APPROVAL_TIMEOUT`.
