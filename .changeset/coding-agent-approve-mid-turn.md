---
"@nifrajs/coding-agent": patch
---

The interactive `nifra-agent` CLI answers `/approve`, `/deny` and `/approvals` while a turn is running. Before, it read no input until the turn ended, so a turn waiting on an approval could never get one. Other prompts and commands typed during a turn still run in order once it ends.
