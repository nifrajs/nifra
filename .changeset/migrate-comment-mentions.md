---
"@nifrajs/cli": minor
---

`nifra migrate layout` lists a moved path that a JS or TS module names only in comments as a follow-up, not an issue, so it no longer fails the run. A mention in code or a string, or in a non-JS tooling file, is still an issue. `followUps[].command` is now optional: a comment to update has no command.
