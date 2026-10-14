---
"@nifrajs/pi": patch
---

Records from a cancelled Pi run no longer leak into the next turn. Pi finishes an aborted run on its own schedule, so a delta or `agent_end` it sent after a new prompt was written became the new turn's output and could complete it with the old answer. `PiBackend` now drains a cancelled run: its records are dropped until Pi ends it (`agent_end`) or answers the abort, a dialog it opens meanwhile is cancelled, and the next prompt is written only after. A cancel before the prompt reached Pi no longer sends Pi an abort.
