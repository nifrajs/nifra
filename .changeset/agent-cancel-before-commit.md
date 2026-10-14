---
"@nifrajs/agent": patch
---

A cancelled turn no longer commits a model answer that arrives after the cancel. A model port that ignores its `signal` could still return output or a tool call, and output validation can be async; `turn` now rechecks the signal once the model answers and again after validating output, and suspends as `cancelled` instead of saving a completed state or running the tool.
