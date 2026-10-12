---
"@nifrajs/coding-agent": minor
---

`CodingAgentRpcServer` takes `approvals`, passed to the approval broker of the host it builds (`timeoutMs`, `maxPending`, `onRequired`, `onResolved`). Without it every RPC-hosted session kept the broker defaults of 5 minutes and 32 pending, so a person who took longer than 5 minutes to answer an approval or a coding tool's question over RPC was denied, and a later answer refused. `approval.request` and `approval.list` report `expiresAt` from the configured timeout. Leaving `approvals` out keeps the defaults.
