---
"@nifrajs/cli": patch
---

On Windows, `nifra upgrade` leaves build output and coverage alone, `nifra_explain` shows a codeframe for project source under a short path, and `nifra i18n check` names its entry with `/`. `nifra check` reports findings in the same order on every platform, and `nifra mcp` keeps the variables a process has besides its `.env` files: the ones Windows copies into every subprocess and the ones a bunfig preload sets.
