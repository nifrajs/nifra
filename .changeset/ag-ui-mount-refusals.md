---
"@nifrajs/ag-ui": patch
---

`mountAgUI` answers refusals and failures with the status they mean, as `mountAgent` now does. A `Response` thrown from `ports` or `evidenceOwner` (a 401 with its challenge, say) is sent as built; before, every throw from either became `400 bad_request`. A refusal thrown from `evidenceOwner` answers `403 { error: "forbidden" }`, and any other throw from `ports` reaches the app's error handling as the fault it is.
