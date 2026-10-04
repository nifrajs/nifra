---
"@nifrajs/agent": patch
---

`AgentDeployment` runs its lifecycle calls one at a time, so each call sees the state the previous one left:

- `cancel()` or `dispose()` during an in-flight `start()` aborts the start's `signal`. It then runs once the start settles, against the workload that start left running. A start that stops on the signal rejects with `cancelled`. Previously the cancel ran first, without the workload's handle, and the start then left the deployment `running`.
- A plan refused by `prepare()` (an invalid plan, a capability or authority refusal) is recorded in `evidenceRecords` as `failed`, like every other refusal.
