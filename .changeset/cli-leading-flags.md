---
"@nifrajs/cli": patch
---

Flags typed before the command (`nifra --json check`, `nifra --env-file .env dev`) now reach the command instead of being silently ignored.
