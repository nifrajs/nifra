---
"@nifrajs/cli": patch
---

`nifra review --diff` no longer drops a server-only import finding (NF-C004) whose route did not change. When a changed module adds the import that pulls server code into the browser bundle, the finding is reported on the route's import line. Review now keeps the finding in scope when any project file on the chain changed. Each NF-C004 finding records the files its chain runs through, and the diagnostic's compatibility view carries them as `modules`.
