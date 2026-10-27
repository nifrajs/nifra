---
"@nifrajs/cli": patch
"@nifrajs/coding-agent": patch
"@nifrajs/core": patch
"@nifrajs/web": patch
---

Internal cleanup: the CLI's check rules, the coding agent's per-node records, the durable backends' scan pages and the web build's steps each have one implementation where there were copies. No behaviour changes.
