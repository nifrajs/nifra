---
"@nifrajs/coding-agent": patch
---

When the reader of `CodingAgentHost.prompt` leaves a turn early, such as an RPC client disconnecting from a non-resumable `turn.send`, the approvals the backend raised in that turn and the host's broker still holds are denied with `"approval turn ended"`, in the broker and the backend. Before, they stayed in `approval.list` until the broker's timeout, and an answer given meanwhile was reported as accepted though the backend had already dropped the approval.
