---
"@nifrajs/coding-agent": minor
---

A `NativeApprovalPort` may `review` a tool call before `NifraBackend` raises an approval. An allow runs the call and a deny refuses it with `REVIEW_DENIED` and a reason the model reads, neither emitting approval events; an ask, any other answer, a throw, or a review still unsettled after the new `reviewTimeoutMs` (default 30 s, at most 10 minutes) raises the approval as before. An abort during a review stops the turn. `NativeApprovalRequest` and `NativeReviewAnswer` are exported.
