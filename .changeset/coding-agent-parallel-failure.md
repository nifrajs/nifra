---
"@nifrajs/coding-agent": patch
---

A `parallel` workflow step stops at its first failure. No queued step starts after a step fails, and `WorkflowRunner.run()` returns only after the steps already running have finished. Previously the failure was reported at once while the remaining steps kept starting.
