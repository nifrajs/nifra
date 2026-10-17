---
"@nifrajs/core": patch
---

Skip the native Node mount preflight when an app has no mounted handlers, avoiding a second route lookup before normal dispatch.
