---
"@nifrajs/coding-agent": minor
---

`OrchestrationHost` keeps one values map for every layer of a run, so a node reads what a node in an earlier layer set, across a pause too. The values stay in memory for the run and are not written into its evidence. `WorkflowRunnerOptions.values` takes the map a runner reads and writes, so a driver can carry values from one run into the next.
