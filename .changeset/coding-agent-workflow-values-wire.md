---
"@nifrajs/coding-agent": patch
---

The RPC `workflow.run` reply now carries the workflow's `values` as a plain object. They were sent as a `Map`, which serialises to `{}`, so a remote caller never saw what the steps set.
