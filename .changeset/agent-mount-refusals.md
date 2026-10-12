---
"@nifrajs/agent": patch
---

`mountAgent` now answers refusals and failures with the status they mean. A `Response` thrown from `ports` or `evidenceOwner` (a 401 with its challenge, say) is sent as built; before, every throw from either became `400 bad_request`. A refusal thrown from `evidenceOwner` now answers `403 { error: "forbidden" }`, and any other throw from `ports` reaches the app's error handling as the fault it is. In JSON mode a fresh run that throws now answers `500 { error: "run_failed" }`, the code the SSE stream already used; `409 resume_unavailable` is reserved for a POST that resumed a turn.
