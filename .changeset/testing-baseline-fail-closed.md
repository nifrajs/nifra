---
"@nifrajs/testing": major
---

`compareAgentEvalBaseline` and `assertAgentEvalBaseline` now fail by default on a verdict the current run stopped producing (`missing`) or whose rubric changed shape (`incomparable`), not only on `regressed`. A verdict new in the current run gets its own `added` code and does not fail. Pass `failOn: ["regressed"]` for the old behaviour. `runAgentFailureMatrix` takes an `execute(boundary, checkpoint)` option that drives the agent under test through each boundary; a case passes only when the injected crash surfaces. Without it the matrix still proves only its own schedule.
