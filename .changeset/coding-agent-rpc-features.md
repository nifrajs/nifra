---
"@nifrajs/coding-agent": patch
---

`CodingAgentRpcServer` session snapshots now list the Agent App features the server answers itself: `approvals` and `resume` always, `checkpoint` and `fork` with a session store or a backend that supports them, and `workflows` with an extension host. An `AgentAppClient` connected to it can call `resume()` instead of being refused for a feature the host never granted.
