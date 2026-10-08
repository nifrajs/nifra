---
"@nifrajs/coding-agent": patch
"@nifrajs/agent-app": patch
"@nifrajs/workbench": patch
---

The coding-agent RPC `approval.list` names each pending approval `approvalId`, the name `approval.resolve` takes, and keeps `id`. `AgentAppClient.listApprovals()` reads either name, so pending approvals from the RPC host are no longer dropped. The workbench refreshes its approval list when a turn reports `approval.required` or `approval.resolved`, while the turn is still streaming.
