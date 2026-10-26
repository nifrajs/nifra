---
"@nifrajs/coding-agent": patch
---

`NifraBackend` tells the model why a tool call was not approved. Its history for a denied, timed-out, or failed approval now holds the error code and the same bounded message `tool.completed` carries, including a reason given when denying, instead of the code alone. A blank denial reason counts as none.
