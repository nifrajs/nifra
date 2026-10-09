---
"@nifrajs/edge": patch
---

An edge route handler that returns nothing now answers an empty `204`, as the full server does, instead of rejecting the fetch.
