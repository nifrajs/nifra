---
"@nifrajs/web": patch
---

Prevent keep-alive from retaining the active visitor's data after an explicit bearer-auth identity change, including cross-tab signals. Freshly loaded data can be kept again without changing the identity cookie.
