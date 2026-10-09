---
"@nifrajs/testing": patch
---

`replayTrajectory` now fires tool faults. Replay runs tools dry, so a tool's own `execute` never runs, and the faults were injected there. A `tool-error`, `cancellation` or `budget-pressure` fault on the `tool` point never fired, and the replay reported a completed run. Tool faults now fire at the budget check that a dry tool call still makes: a tool error fails the call with `execution_failed`, a cancellation cancels the call and the run, and budget pressure fails the call with `budget_exceeded`. Replay still runs no real tool.
