---
"@nifrajs/coding-agent": patch
---

`CodingAgentHost.resolveApproval` settles the approval with the host's broker before telling the backend, and returns `undefined` without telling the backend when the broker no longer holds it (unknown, expired, already settled, or bound to a coordinate). An approval the broker denies on its own, by timeout or when it closes, is denied in the backend too, so a backend that keeps approvals open longer than the host, or a Pi confirmation still waiting, can no longer run the action after the host expired it.
