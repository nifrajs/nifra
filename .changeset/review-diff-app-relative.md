---
"@nifrajs/cli": patch
---

`nifra review --diff` run from an app inside a larger repository (`apps/web` in a monorepo) now reviews the app's changed files. Git listed changed tracked files relative to the repository root while findings are relative to the app, so a new error in a changed file was counted out of scope and the review passed.
