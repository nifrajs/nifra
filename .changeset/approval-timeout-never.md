---
"@nifrajs/coding-agent": minor
---

`ApprovalManager`'s `timeoutMs` and `NifraBackend`'s `approvalTimeoutMs` accept `"never"`, which keeps an approval (or a coding tool's question) pending with no timer. It still settles on an answer, a cancel, the end of its turn, session close, and host close, and `maxPending` still bounds how many can wait. A never-expiring `ApprovalRequest` reports `expiresAt: APPROVAL_NEVER_EXPIRES_AT` (8640000000000000, the largest time a `Date` holds): it survives JSON, and `now < expiresAt` keeps treating it as live. Numbers keep the 5-minute default and the 1 ms to 24 h range, and every other value is rejected. `approvalRequestFromEvent` takes the timeout as a second argument (pass `ApprovalManager.timeoutMs`) instead of assuming 5 minutes.
