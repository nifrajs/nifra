---
"@nifrajs/agent": patch
---

`maxOutputBytes` bounds a local process's total captured output rather than each stream separately. A
process writing to both stdout and stderr could retain twice the configured limit, so the option's
value did not describe what a run could hold. Both streams now draw from one budget.
