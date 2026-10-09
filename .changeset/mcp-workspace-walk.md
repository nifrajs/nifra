---
"@nifrajs/cli": patch
---

`nifra mcp` started at a workspace root no longer walks every `node_modules` below a `**` workspace pattern to find the nifra app. The probe reads only the directories a pattern can match, within a fixed budget, and an unreadable `node_modules` no longer makes it fail.
