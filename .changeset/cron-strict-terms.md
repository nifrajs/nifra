---
"@nifrajs/cron": patch
---

`parseCron` now accepts only plain decimal terms (`*`, `n`, `a-b`, each with an optional `/step`) and rejects `-5`, `1-2-3`, `0x1F`, `1e1`, `+3` and `*/5/7`, which used to parse into surprising schedules. A bare value with a step, such as `5/15`, now runs from that value to the end of the field (5, 20, 35, 50) as standard cron does; it used to mean only 5.
